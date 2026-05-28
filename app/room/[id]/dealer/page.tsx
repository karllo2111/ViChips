'use client';

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  formatRupiah,
  isBettingRoundComplete,
  calculatePayout,
  getNextActiveIndex,
  getAutoWinner,
  resetPlayersForNewPhase,
  resetPlayersForNewHand,
  getNextPhase,
  assignBlinds,
  rotateBlindIndices,
} from "@/lib/poker-logic";
import type { Player, RoomData, GamePhase } from "@/lib/poker-logic";

export default function DealerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: roomId } = use(params);
  const router = useRouter();

  // State
  const [room, setRoom] = useState<RoomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dealerName, setDealerName] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  // Blinds Setup Modal State
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [smallBlindInput, setSmallBlindInput] = useState("1000");
  const [bigBlindInput, setBigBlindInput] = useState("2000");
  const [selectedSbPlayerIndex, setSelectedSbPlayerIndex] = useState(0);

  // Payout Modal State
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [selectedWinners, setSelectedWinners] = useState<string[]>([]); // player IDs

  // Toast helper
  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Fetch and Subscribe
  useEffect(() => {
    const name = localStorage.getItem("vi_name") || "";
    const role = localStorage.getItem("vi_role") || "player";
    setDealerName(name);

    if (role !== "dealer") {
      router.replace(`/room/${roomId}/player`);
      return;
    }

    const fetchRoom = async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .eq("id", roomId)
        .single();

      if (error || !data) {
        showToast("Gagal memuat data room", "error");
        setLoading(false);
        return;
      }
      setRoom(data as RoomData);
      setLoading(false);
    };

    fetchRoom();

    const channel = supabase
      .channel(`room-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        (payload) => {
          setRoom(payload.new as RoomData);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, router]);

  if (loading) {
    return (
      <div style={{ minHeight: "100dvh", background: "var(--bg-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 16 }}>Memuat data meja...</div>
      </div>
    );
  }

  if (!room) {
    return (
      <div style={{ minHeight: "100dvh", background: "var(--bg-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 16 }}>Meja tidak ditemukan.</div>
      </div>
    );
  }

  const players: Player[] = room.players || [];
  const activePlayers = players.filter((p) => !p.is_folded);
  const activeCount = activePlayers.length;

  // ── START GAME / ROUND SETUP ──
  const openBlindsSetup = () => {
    if (players.length < 2) {
      showToast("Butuh minimal 2 pemain untuk memulai game!", "error");
      return;
    }
    // Set default selected SB index based on room.sb_index
    setSelectedSbPlayerIndex(room.sb_index < players.length ? room.sb_index : 0);
    setShowSetupModal(true);
  };

  const handleStartGame = async () => {
    const sbVal = parseInt(smallBlindInput) || 1000;
    const bbVal = parseInt(bigBlindInput) || 2000;

    if (sbVal <= 0 || bbVal <= 0 || bbVal <= sbVal) {
      showToast("Input blind tidak valid! Big Blind harus lebih besar dari Small Blind.", "error");
      return;
    }

    const sbIdx = selectedSbPlayerIndex;
    const bbIdx = (sbIdx + 1) % players.length;

    // Deduct forced blind contributions
    const updatedPlayers = players.map((p, idx) => {
      let balance = p.current_balance;
      let contribution = 0;
      let position: "SB" | "BB" | "REGULAR" = "REGULAR";

      if (idx === sbIdx) {
        contribution = Math.min(balance, sbVal);
        balance -= contribution;
        position = "SB";
      } else if (idx === bbIdx) {
        contribution = Math.min(balance, bbVal);
        balance -= contribution;
        position = "BB";
      }

      return {
        ...p,
        current_balance: balance,
        round_contribution: contribution,
        total_game_contribution: contribution,
        is_folded: balance <= 0 && contribution === 0, // auto fold if 0 balance and no contribution
        is_all_in: balance === 0 && contribution > 0,
        position,
        is_current_turn: false,
        has_acted: false,
      };
    });

    // SB acts first pre-flop? No, in pre-flop UTG (Under The Gun) acts first.
    // UTG is the player to the left of the Big Blind.
    const utgIndex = (bbIdx + 1) % updatedPlayers.length;
    
    // Set UTG turn
    updatedPlayers[utgIndex].is_current_turn = true;

    const initialPot = updatedPlayers.reduce((acc, p) => acc + p.round_contribution, 0);

    const highestBet = Math.max(sbVal, bbVal);

    const { error } = await supabase
      .from("rooms")
      .update({
        status: "playing",
        current_phase: "PRE-FLOP",
        pot: initialPot,
        current_highest_bet: highestBet,
        last_raise_increment: bbVal, // Min raise increment is 1 BB
        small_blind: sbVal,
        big_blind: bbVal,
        sb_index: sbIdx,
        bb_index: bbIdx,
        dealer_index: sbIdx, // Dealer chip sits on SB or custom
        dealer_id: dealerName,
        players: updatedPlayers,
        winner: null,
      })
      .eq("id", roomId);

    if (error) {
      showToast("Gagal memulai game: " + error.message, "error");
    } else {
      showToast("Game dimulai! Fase Pre-Flop", "success");
      setShowSetupModal(false);
    }
  };

  // ── NEXT PHASE CONTROL ──
  const handleNextPhase = async () => {
    if (room.current_phase === "WAITING" || room.current_phase === "SHOWDOWN") return;

    // Check equalization
    if (!isBettingRoundComplete(players, room.current_highest_bet)) {
      showToast("Taruhan belum sama! Semua pemain aktif harus berkontribusi setara sebelum lanjut.", "error");
      return;
    }

    const nextP = getNextPhase(room.current_phase);

    // If next phase is SHOWDOWN or all but one folded
    const autoWinner = getAutoWinner(players);
    if (autoWinner) {
      // If only one player left unfolded, they win the pot automatically!
      handleAutoWin(autoWinner);
      return;
    }

    // Reset players for new phase
    let updatedPlayers = resetPlayersForNewPhase(players);

    // In Flop/Turn/River, the Small Blind (or the first active player to their left) acts first.
    let firstActorIndex = room.sb_index;
    if (updatedPlayers[firstActorIndex].is_folded || updatedPlayers[firstActorIndex].is_all_in) {
      const nextActive = getNextActiveIndex(updatedPlayers, firstActorIndex);
      if (nextActive !== null) {
        firstActorIndex = nextActive;
      }
    }
    
    if (updatedPlayers[firstActorIndex]) {
      updatedPlayers[firstActorIndex].is_current_turn = true;
    }

    const { error } = await supabase
      .from("rooms")
      .update({
        current_phase: nextP,
        current_highest_bet: 0,
        last_raise_increment: room.big_blind, // Reset min raise to 1 BB
        players: updatedPlayers,
        status: "playing",
      })
      .eq("id", roomId);

    if (error) {
      showToast("Gagal memperbarui fase: " + error.message, "error");
    } else {
      showToast(`Fase bergeser ke ${nextP}!`, "success");
    }
  };

  const handleAutoWin = async (winnerPlayer: Player) => {
    // 9% tax
    const payout = calculatePayout(room.pot, 1);

    const updatedPlayers = players.map((p) => {
      if (p.id === winnerPlayer.id) {
        return {
          ...p,
          current_balance: p.current_balance + payout.netPot,
        };
      }
      return p;
    });

    const nextBlinds = rotateBlindIndices(room.sb_index, room.bb_index, players.length);

    const { error } = await supabase
      .from("rooms")
      .update({
        status: "waiting",
        current_phase: "WAITING",
        pot: 0,
        current_highest_bet: 0,
        last_raise_increment: 0,
        players: resetPlayersForNewHand(updatedPlayers),
        winner: winnerPlayer.name,
        sb_index: nextBlinds.newSbIndex,
        bb_index: nextBlinds.newBbIndex,
      })
      .eq("id", roomId);

    if (error) {
      showToast("Gagal memproses auto-win: " + error.message, "error");
    } else {
      showToast(`${winnerPlayer.name} menang otomatis karena semua pemain lain FOLD!`, "success");
    }
  };

  // ── MANUAL PAYOUT (SPLIT / SINGLE WINNER) ──
  const openPayoutModal = () => {
    setSelectedWinners([]);
    setShowPayoutModal(true);
  };

  const handleConfirmPayout = async () => {
    if (selectedWinners.length === 0) {
      showToast("Pilih minimal satu pemenang!", "error");
      return;
    }

    const payout = calculatePayout(room.pot, selectedWinners.length);

    const updatedPlayers = players.map((p) => {
      if (selectedWinners.includes(p.id)) {
        return {
          ...p,
          current_balance: p.current_balance + payout.perWinner,
        };
      }
      return p;
    });

    // If there is remainder, give it to the first winner in the list
    if (payout.remainder > 0 && selectedWinners.length > 0) {
      const firstWinnerId = selectedWinners[0];
      const idx = updatedPlayers.findIndex((p) => p.id === firstWinnerId);
      if (idx !== -1) {
        updatedPlayers[idx].current_balance += payout.remainder;
      }
    }

    const winnersNames = players
      .filter((p) => selectedWinners.includes(p.id))
      .map((p) => p.name)
      .join(" & ");

    const nextBlinds = rotateBlindIndices(room.sb_index, room.bb_index, players.length);

    const { error } = await supabase
      .from("rooms")
      .update({
        status: "waiting",
        current_phase: "WAITING",
        pot: 0,
        current_highest_bet: 0,
        last_raise_increment: 0,
        players: resetPlayersForNewHand(updatedPlayers),
        winner: winnersNames,
        sb_index: nextBlinds.newSbIndex,
        bb_index: nextBlinds.newBbIndex,
      })
      .eq("id", roomId);

    if (error) {
      showToast("Gagal memproses payout: " + error.message, "error");
    } else {
      showToast(`Payout sukses! Selamat kepada ${winnersNames}`, "success");
      setShowPayoutModal(false);
    }
  };

  // ── RESET ROOM / KICK / RESTART ──
  const handleResetRoom = async () => {
    if (!confirm("Apakah Anda yakin ingin me-reset seluruh game room ini? Semua taruhan akan hilang, balance pemain kembali ke awal.")) return;

    const resetPlayers = players.map((p) => ({
      ...p,
      current_balance: 500000, // standard default
      round_contribution: 0,
      total_game_contribution: 0,
      is_folded: false,
      is_all_in: false,
      position: "REGULAR" as const,
      is_current_turn: false,
      has_acted: false,
    }));

    const { error } = await supabase
      .from("rooms")
      .update({
        status: "waiting",
        current_phase: "WAITING",
        pot: 0,
        current_highest_bet: 0,
        last_raise_increment: 0,
        players: resetPlayers,
        winner: null,
        sb_index: 0,
        bb_index: 1,
      })
      .eq("id", roomId);

    if (error) {
      showToast("Gagal mereset room: " + error.message, "error");
    } else {
      showToast("Room berhasil di-reset!", "success");
    }
  };

  const handleKickPlayer = async (playerId: string, playerName: string) => {
    if (!confirm(`Keluarkan ${playerName} dari meja?`)) return;

    const filteredPlayers = players.filter((p) => p.id !== playerId);

    const { error } = await supabase
      .from("rooms")
      .update({
        players: filteredPlayers,
      })
      .eq("id", roomId);

    if (error) {
      showToast("Gagal mengeluarkan pemain", "error");
    } else {
      showToast(`${playerName} dikeluarkan dari meja.`, "info");
    }
  };

  // Check if current phase betting is complete
  const canNextPhase = room.current_phase !== "WAITING" && room.current_phase !== "SHOWDOWN" && isBettingRoundComplete(players, room.current_highest_bet);

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg-primary)", padding: "16px 12px 100px 12px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        
        {/* ── Toast Notification ── */}
        {toast && (
          <div className={`toast toast-${toast.type}`}>
            <span>{toast.type === "success" ? "✅" : toast.type === "error" ? "❌" : "ℹ️"}</span>
            <span>{toast.message}</span>
          </div>
        )}

        {/* ── Header ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="phase-badge phase-waiting" style={{ background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.4)", color: "#a78bfa" }}>
                🎰 Host/Dealer Screen
              </span>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Room ID: {roomId.slice(0, 8)}...</span>
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 900, marginTop: 4 }}>{room.room_name}</h1>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost" onClick={handleResetRoom} style={{ fontSize: 12, padding: "8px 12px" }}>
              🔄 Reset Room
            </button>
            <button className="btn-ghost" onClick={() => router.push("/")} style={{ fontSize: 12, padding: "8px 12px" }}>
              🚪 Lobby
            </button>
          </div>
        </div>

        {/* ── Game Stats & State Panel ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 20 }}>
          <div className="glass" style={{ padding: 16, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
              Fase Berjalan
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`phase-badge phase-${room.current_phase.toLowerCase().replace("-", "")}`} style={{ fontSize: 14, padding: "6px 14px" }}>
                {room.current_phase}
              </span>
              {room.status === "paused" && (
                <span className="mono" style={{ fontSize: 11, color: "var(--gold)", fontWeight: 700 }}>
                  (PAUSED - READY)
                </span>
              )}
            </div>
          </div>

          <div className="glass" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
              Total Pot di Meja
            </div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)" }}>
              {formatRupiah(room.pot)}
            </div>
          </div>

          <div className="glass" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
              Blind Pasangan
            </div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-secondary)" }}>
              {room.small_blind > 0 ? `${formatRupiah(room.small_blind)} / ${formatRupiah(room.big_blind)}` : "Belum di-setup"}
            </div>
          </div>
        </div>

        {/* ── FELT POKER TABLE VISUAL OVERVIEW ── */}
        <div className="felt-table" style={{ borderRadius: 28, padding: 24, marginBottom: 24, position: "relative", minHeight: 180, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <div style={{ position: "absolute", top: 12, left: 16, fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.25)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            VI-CHIP Poker Virtual Table
          </div>
          
          <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>
            POT SAAT INI
          </div>
          <div className="mono" style={{ fontSize: 36, fontWeight: 900, color: "#fff", textShadow: "0 4px 10px rgba(0,0,0,0.5)" }}>
            {formatRupiah(room.pot)}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <div style={{ background: "rgba(0,0,0,0.3)", padding: "4px 10px", borderRadius: 8, fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
              Highest Bet: <span className="mono font-bold" style={{ color: "var(--gold)" }}>{formatRupiah(room.current_highest_bet)}</span>
            </div>
            <div style={{ background: "rgba(0,0,0,0.3)", padding: "4px 10px", borderRadius: 8, fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
              Min Raise: <span className="mono font-bold" style={{ color: "var(--orange-raise)" }}>{formatRupiah(room.current_highest_bet + room.last_raise_increment)}</span>
            </div>
          </div>

          {room.winner && (
            <div style={{ marginTop: 16, background: "rgba(250,204,21,0.15)", border: "1px solid var(--gold)", color: "var(--gold)", padding: "8px 16px", borderRadius: 12, fontSize: 13, fontWeight: 700, animation: "scale-in 0.2s" }}>
              🏆 Pemenang Ronde Terakhir: {room.winner}
            </div>
          )}
        </div>

        {/* ── PLAYER MANAGEMENT ── */}
        <div className="glass" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)" }}>
              Daftar Pemain ({players.length})
            </h2>
            {room.current_phase === "WAITING" && (
              <button className="btn-primary" onClick={openBlindsSetup} style={{ fontSize: 13, padding: "8px 16px" }}>
                🎮 Setup Blind & Mulai Game
              </button>
            )}
          </div>

          {players.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--text-muted)" }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📱</div>
              <p style={{ fontSize: 14 }}>Belum ada pemain yang masuk ke room ini.</p>
              <p style={{ fontSize: 12, marginTop: 4 }}>Bagikan Room ID atau nama room untuk membiarkan pemain bergabung.</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {players.map((player, index) => {
                const isSb = player.position === "SB";
                const isBb = player.position === "BB";
                const isTurn = player.is_current_turn && room.current_phase !== "WAITING" && room.current_phase !== "SHOWDOWN";

                let cardClass = "player-card";
                if (isTurn) cardClass += " is-active turn-pulse";
                if (player.is_folded) cardClass += " is-folded";
                if (player.is_all_in) cardClass += " is-allin";
                if (isSb) cardClass += " is-sb";
                if (isBb) cardClass += " is-bb";

                return (
                  <div
                    key={player.id}
                    className={cardClass}
                    style={{
                      padding: 16,
                      background: "rgba(255,255,255,0.02)",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      position: "relative",
                    }}
                  >
                    {/* Position and Status badges */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        {isSb && (
                          <span style={{ background: "var(--emerald-check)", color: "#fff", fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4 }}>
                            SB
                          </span>
                        )}
                        {isBb && (
                          <span style={{ background: "var(--orange-raise)", color: "#fff", fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4 }}>
                            BB
                          </span>
                        )}
                        {player.is_all_in && (
                          <span style={{ background: "var(--purple-dealer)", color: "#fff", fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4 }}>
                            ALL-IN
                          </span>
                        )}
                        {player.is_folded && (
                          <span style={{ background: "var(--red-fold)", color: "#fff", fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4 }}>
                            FOLD
                          </span>
                        )}
                        {isTurn && (
                          <span style={{ background: "var(--gold)", color: "#000", fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4, animation: "pulse 1s infinite" }}>
                            GILIRAN
                          </span>
                        )}
                      </div>
                      
                      {room.current_phase === "WAITING" && (
                        <button
                          onClick={() => handleKickPlayer(player.id, player.name)}
                          style={{ background: "transparent", border: "none", color: "var(--red-fold)", fontSize: 11, cursor: "pointer", fontWeight: 700 }}
                        >
                          Kick ❌
                        </button>
                      )}
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
                        {player.name}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        Saldo: <span className="mono" style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{formatRupiah(player.current_balance)}</span>
                      </div>
                    </div>

                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        Taruhan Ronde:
                      </div>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--gold)" }}>
                        {formatRupiah(player.round_contribution)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── BOTTOM ACTION BAR FOR DEALER PHASE CONTROL ── */}
        {room.current_phase !== "WAITING" && (
          <div className="bottom-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>STATUS TARUHAN SEKARANG:</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {canNextPhase ? (
                  <span style={{ color: "var(--emerald-check)" }}>✅ Taruhan Setara. Siap lanjut ke fase berikutnya!</span>
                ) : room.current_phase === "SHOWDOWN" ? (
                  <span style={{ color: "var(--gold)" }}>🏁 Babak Showdown. Tentukan pemenang pot!</span>
                ) : (
                  <span style={{ color: "var(--orange-raise)" }}>⚠️ Menunggu pemain bertaruh / menyamakan nominal...</span>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              {room.current_phase !== "SHOWDOWN" ? (
                <button
                  className="btn-primary"
                  onClick={handleNextPhase}
                  disabled={!canNextPhase}
                  style={{ display: "flex", alignItems: "center", gap: 6, opacity: canNextPhase ? 1 : 0.5 }}
                >
                  ⏩ Lanjut Fase ({getNextPhase(room.current_phase)})
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={openPayoutModal}
                  style={{ display: "flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg, #7c3aed, #a78bfa)", color: "#fff", boxShadow: "0 4px 15px rgba(124,58,237,0.3)" }}
                >
                  🏆 Bagikan Pot & Payout
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── MODAL SETUP BLINDS ── */}
        {showSetupModal && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSetupModal(false); }}>
            <div className="modal-box">
              <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Setup Blind & Mulai</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
                Tentukan nilai blind dan posisi Small Blind untuk ronde ini.
              </p>

              <label className="label">Small Blind (Rp)</label>
              <input
                className="input-field"
                type="number"
                value={smallBlindInput}
                onChange={(e) => {
                  setSmallBlindInput(e.target.value);
                  setBigBlindInput(String(parseInt(e.target.value) * 2 || 0));
                }}
                style={{ marginBottom: 16 }}
              />

              <label className="label">Big Blind (Rp)</label>
              <input
                className="input-field"
                type="number"
                value={bigBlindInput}
                onChange={(e) => setBigBlindInput(e.target.value)}
                style={{ marginBottom: 16 }}
              />

              <label className="label">Pilih Small Blind (SB) Player</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 150, overflowY: "auto", marginBottom: 20, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 8 }}>
                {players.map((player, idx) => (
                  <button
                    key={player.id}
                    onClick={() => setSelectedSbPlayerIndex(idx)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: selectedSbPlayerIndex === idx ? "rgba(250,204,21,0.15)" : "transparent",
                      border: "none",
                      color: selectedSbPlayerIndex === idx ? "var(--gold)" : "var(--text-secondary)",
                      textAlign: "left",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontSize: 13,
                      display: "flex",
                      justifyContent: "space-between"
                    }}
                  >
                    <span>👤 {player.name}</span>
                    {selectedSbPlayerIndex === idx && <span>(SB)</span>}
                    {((idx === (selectedSbPlayerIndex + 1) % players.length) && players.length > 1) && <span style={{ color: "var(--orange-raise)", opacity: 0.8 }}>(BB otomatis)</span>}
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button className="btn-ghost" onClick={() => setShowSetupModal(false)}>
                  Batal
                </button>
                <button className="btn-primary" onClick={handleStartGame}>
                  Mulai Game 🚀
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── MODAL PAYOUT / MANUAL SPLIT POT ── */}
        {showPayoutModal && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowPayoutModal(false); }}>
            <div className="modal-box" style={{ maxWidth: 480 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Bagikan Pot (Payout)</h2>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
                Centang pemenang ronde ini. Pot akan otomatis dipotong pajak rumah 9% sebelum dibagikan.
              </p>

              {/* Tax Calculations */}
              {(() => {
                const count = selectedWinners.length || 1;
                const pay = calculatePayout(room.pot, count);
                return (
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, padding: 14, marginBottom: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                      <span style={{ color: "var(--text-muted)" }}>Total Pot Kotor:</span>
                      <span className="mono" style={{ fontWeight: 600 }}>{formatRupiah(pay.totalPot)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                      <span style={{ color: "var(--text-muted)" }}>Pajak Virtual (9%):</span>
                      <span className="mono" style={{ color: "var(--red-fold)", fontWeight: 600 }}>-{formatRupiah(pay.tax)}</span>
                    </div>
                    <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "8px 0" }}></div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}>
                      <span style={{ fontWeight: 700 }}>Total Pot Bersih:</span>
                      <span className="mono" style={{ color: "var(--gold)", fontWeight: 800 }}>{formatRupiah(pay.netPot)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "var(--text-muted)" }}>Penerimaan per Pemenang:</span>
                      <span className="mono" style={{ color: "var(--emerald-check)", fontWeight: 700 }}>
                        {formatRupiah(pay.perWinner)} {selectedWinners.length > 1 ? `(x${selectedWinners.length})` : ""}
                      </span>
                    </div>
                    {pay.remainder > 0 && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, fontStyle: "italic" }}>
                        * Sisa pecahan pembagian {formatRupiah(pay.remainder)} akan diberikan ke pemenang pertama.
                      </div>
                    )}
                  </div>
                );
              })()}

              <label className="label">Pilih Pemenang (Bisa centang lebih dari 1 untuk split pot)</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto", marginBottom: 20, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 8 }}>
                {players.map((player) => {
                  const isChecked = selectedWinners.includes(player.id);
                  return (
                    <button
                      key={player.id}
                      onClick={() => {
                        if (isChecked) {
                          setSelectedWinners(selectedWinners.filter((id) => id !== player.id));
                        } else {
                          setSelectedWinners([...selectedWinners, player.id]);
                        }
                      }}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 8,
                        background: isChecked ? "rgba(16,185,129,0.1)" : "transparent",
                        border: "none",
                        color: isChecked ? "var(--emerald-check)" : "var(--text-secondary)",
                        textAlign: "left",
                        fontWeight: 700,
                        cursor: "pointer",
                        fontSize: 13,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center"
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 15 }}>{isChecked ? "✅" : "⬜"}</span>
                        <span>{player.name} {player.is_folded && <span style={{ color: "var(--red-fold)", fontSize: 11 }}>(Folded)</span>}</span>
                      </span>
                      <span className="mono" style={{ fontSize: 12, opacity: 0.8 }}>Bal: {formatRupiah(player.current_balance)}</span>
                    </button>
                  );
                })}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button className="btn-ghost" onClick={() => setShowPayoutModal(false)}>
                  Batal
                </button>
                <button className="btn-primary" onClick={handleConfirmPayout} disabled={selectedWinners.length === 0} style={{ background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", boxShadow: "0 4px 15px rgba(16,185,129,0.3)" }}>
                  Konfirmasi Payout 💰
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
