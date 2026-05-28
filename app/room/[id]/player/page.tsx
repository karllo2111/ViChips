'use client';

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  formatRupiah,
  isBettingRoundComplete,
  validateRaise,
  getNextActiveIndex,
  getAutoWinner,
  calculatePayout,
  resetPlayersForNewHand,
  rotateBlindIndices,
} from "@/lib/poker-logic";
import type { Player, RoomData } from "@/lib/poker-logic";

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: roomId } = use(params);
  const router = useRouter();

  // State
  const [room, setRoom] = useState<RoomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [myId, setMyId] = useState("");
  const [myName, setMyName] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  // Input states for betting/raising
  const [betInput, setBetInput] = useState("");
  const [raiseInput, setRaiseInput] = useState("");
  const [showBetPanel, setShowBetPanel] = useState(false);
  const [showRaisePanel, setShowRaisePanel] = useState(false);

  // Toast helper
  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // 1. Fetch & Subscribe Realtime
  useEffect(() => {
    // Generate or get unique player ID
    let pid = localStorage.getItem("vi_player_id");
    if (!pid) {
      pid = "pl_" + Math.random().toString(36).substring(2, 15);
      localStorage.setItem("vi_player_id", pid);
    }
    setMyId(pid);

    const name = localStorage.getItem("vi_name") || "";
    setMyName(name);

    if (!name) {
      router.replace("/");
      return;
    }

    const fetchRoomAndJoin = async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .eq("id", roomId)
        .single();

      if (error || !data) {
        showToast("Gagal memuat room data", "error");
        setLoading(false);
        return;
      }

      const currentRoom = data as RoomData;
      const playerList = currentRoom.players || [];
      const exists = playerList.some((p) => p.name === name || p.id === pid);

      if (!exists) {
        // Automatically join the room
        const savedBalance = localStorage.getItem("vi_balance") || "500000";
        const bal = parseInt(savedBalance) || 500000;

        const newPlayer: Player = {
          id: pid,
          name: name,
          current_balance: bal,
          round_contribution: 0,
          total_game_contribution: 0,
          is_folded: currentRoom.current_phase !== "WAITING", // spectator if game in progress
          is_all_in: false,
          position: "REGULAR",
          is_current_turn: false,
          has_acted: currentRoom.current_phase !== "WAITING", // bypass turn check this round
        };

        const updatedPlayers = [...playerList, newPlayer];

        const { error: joinError, data: updatedData } = await supabase
          .from("rooms")
          .update({ players: updatedPlayers })
          .eq("id", roomId)
          .select()
          .single();

        if (joinError) {
          showToast("Gagal bergabung ke meja", "error");
        } else if (updatedData) {
          setRoom(updatedData as RoomData);
          showToast(`Berhasil bergabung ke meja sebagai ${name}!`, "success");
        }
      } else {
        setRoom(currentRoom);
      }
      setLoading(false);
    };

    fetchRoomAndJoin();

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
        <div style={{ color: "var(--text-muted)", fontSize: 16 }}>Memasuki meja...</div>
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
  const myPlayerIndex = players.findIndex((p) => p.id === myId);
  const myPlayer = players[myPlayerIndex];

  const currentHighestBet = room.current_highest_bet || 0;
  const isMyTurn = myPlayer?.is_current_turn && room.current_phase !== "WAITING" && room.current_phase !== "SHOWDOWN";

  // Conditions
  const isConditionA = myPlayer && (currentHighestBet === 0 || myPlayer.round_contribution === currentHighestBet);

  // Helper: check if betting round should pause
  const processBettingRoundTransition = (updatedPlayers: Player[], newHighestBet: number) => {
    // If only 1 player remains unfolded, they win pot automatically!
    const autoWinner = getAutoWinner(updatedPlayers);
    if (autoWinner) {
      handleAutoWin(updatedPlayers, autoWinner);
      return;
    }

    if (isBettingRoundComplete(updatedPlayers, newHighestBet)) {
      // Pause game, wait for dealer to advance phase
      supabase
        .from("rooms")
        .update({
          players: updatedPlayers.map((p) => ({ ...p, is_current_turn: false })),
          status: "paused",
        })
        .eq("id", roomId)
        .then(({ error }) => {
          if (error) showToast("Error updating round state", "error");
        });
    } else {
      // Pass turn to next active player
      const nextIdx = getNextActiveIndex(updatedPlayers, myPlayerIndex);
      if (nextIdx !== null) {
        const finalPlayers = updatedPlayers.map((p, idx) => ({
          ...p,
          is_current_turn: idx === nextIdx,
        }));
        
        supabase
          .from("rooms")
          .update({
            players: finalPlayers,
          })
          .eq("id", roomId)
          .then(({ error }) => {
            if (error) showToast("Error passing turn", "error");
          });
      } else {
        // No next active player (all folding/all-in), so round complete
        supabase
          .from("rooms")
          .update({
            players: updatedPlayers.map((p) => ({ ...p, is_current_turn: false })),
            status: "paused",
          })
          .eq("id", roomId)
          .then(({ error }) => {
            if (error) showToast("Error pausing round", "error");
          });
      }
    }
  };

  const handleAutoWin = async (currentPlayers: Player[], winner: Player) => {
    const payout = calculatePayout(room.pot, 1);

    const updatedPlayers = currentPlayers.map((p) => {
      if (p.id === winner.id) {
        return {
          ...p,
          current_balance: p.current_balance + payout.netPot,
        };
      }
      return p;
    });

    const nextBlinds = rotateBlindIndices(room.sb_index, room.bb_index, players.length);

    await supabase
      .from("rooms")
      .update({
        status: "waiting",
        current_phase: "WAITING",
        pot: 0,
        current_highest_bet: 0,
        last_raise_increment: 0,
        players: resetPlayersForNewHand(updatedPlayers),
        winner: winner.name,
        sb_index: nextBlinds.newSbIndex,
        bb_index: nextBlinds.newBbIndex,
      })
      .eq("id", roomId);

    showToast(`${winner.name} menang otomatis ronde karena semua pemain lain FOLD!`, "success");
  };

  // ── ACTIONS ──

  const handleCheck = () => {
    if (!isMyTurn || !isConditionA) return;

    const updatedPlayers = players.map((p, idx) => {
      if (idx === myPlayerIndex) {
        return { ...p, has_acted: true };
      }
      return p;
    });

    processBettingRoundTransition(updatedPlayers, currentHighestBet);
    showToast("Anda melakukan CHECK", "info");
  };

  const handleFold = () => {
    if (!isMyTurn) return;

    const updatedPlayers = players.map((p, idx) => {
      if (idx === myPlayerIndex) {
        return { ...p, is_folded: true, has_acted: true };
      }
      return p;
    });

    processBettingRoundTransition(updatedPlayers, currentHighestBet);
    showToast("Anda melakukan FOLD", "info");
  };

  const handleCall = () => {
    if (!isMyTurn || isConditionA) return;

    const callDifference = currentHighestBet - myPlayer.round_contribution;
    let finalContributionAdded = callDifference;
    let isAllInAction = false;

    const updatedPlayers = players.map((p, idx) => {
      if (idx === myPlayerIndex) {
        const bal = p.current_balance;
        if (callDifference >= bal) {
          // All-in Call
          finalContributionAdded = bal;
          isAllInAction = true;
          return {
            ...p,
            current_balance: 0,
            round_contribution: p.round_contribution + bal,
            total_game_contribution: p.total_game_contribution + bal,
            is_all_in: true,
            has_acted: true,
          };
        } else {
          // Standard Call
          return {
            ...p,
            current_balance: bal - callDifference,
            round_contribution: currentHighestBet,
            total_game_contribution: p.total_game_contribution + callDifference,
            has_acted: true,
          };
        }
      }
      return p;
    });

    const newPot = room.pot + finalContributionAdded;

    supabase
      .from("rooms")
      .update({
        pot: newPot,
      })
      .eq("id", roomId)
      .then(({ error }) => {
        if (!error) {
          processBettingRoundTransition(updatedPlayers, currentHighestBet);
          showToast(isAllInAction ? "Anda melakukan ALL-IN CALL!" : `Anda melakukan CALL ${formatRupiah(callDifference)}`, "info");
        }
      });
  };

  const handleBet = (amount: number) => {
    if (!isMyTurn || !isConditionA) return;

    if (amount < room.big_blind) {
      showToast(`Taruhan minimal adalah 1 Big Blind (${formatRupiah(room.big_blind)})`, "error");
      return;
    }
    if (amount > myPlayer.current_balance) {
      showToast("Saldo Anda tidak mencukupi!", "error");
      return;
    }

    const isAllInAction = amount === myPlayer.current_balance;

    const updatedPlayers = players.map((p, idx) => {
      if (idx === myPlayerIndex) {
        return {
          ...p,
          current_balance: p.current_balance - amount,
          round_contribution: amount,
          total_game_contribution: p.total_game_contribution + amount,
          is_all_in: isAllInAction,
          has_acted: true,
        };
      }
      // Reset has_acted for all other active players since a bet is placed
      if (!p.is_folded && !p.is_all_in && idx !== myPlayerIndex) {
        return { ...p, has_acted: false };
      }
      return p;
    });

    const newPot = room.pot + amount;

    supabase
      .from("rooms")
      .update({
        pot: newPot,
        current_highest_bet: amount,
        last_raise_increment: amount,
      })
      .eq("id", roomId)
      .then(({ error }) => {
        if (!error) {
          processBettingRoundTransition(updatedPlayers, amount);
          showToast(isAllInAction ? "Anda melakukan ALL-IN BET!" : `Anda bertaruh ${formatRupiah(amount)}`, "success");
          setShowBetPanel(false);
          setBetInput("");
        }
      });
  };

  const handleRaise = (newTotalAmount: number) => {
    if (!isMyTurn || isConditionA) return;

    const validation = validateRaise(newTotalAmount, currentHighestBet, room.last_raise_increment);
    if (!validation.valid) {
      showToast(`Raise minimal adalah ${formatRupiah(validation.minRequired)}`, "error");
      return;
    }

    const additionalNeeded = newTotalAmount - myPlayer.round_contribution;
    if (additionalNeeded > myPlayer.current_balance) {
      showToast("Saldo Anda tidak mencukupi untuk nominal raise ini!", "error");
      return;
    }

    const isAllInAction = additionalNeeded === myPlayer.current_balance;

    const updatedPlayers = players.map((p, idx) => {
      if (idx === myPlayerIndex) {
        return {
          ...p,
          current_balance: p.current_balance - additionalNeeded,
          round_contribution: newTotalAmount,
          total_game_contribution: p.total_game_contribution + additionalNeeded,
          is_all_in: isAllInAction,
          has_acted: true,
        };
      }
      // Reset has_acted for all other active players to respond to this raise
      if (!p.is_folded && !p.is_all_in && idx !== myPlayerIndex) {
        return { ...p, has_acted: false };
      }
      return p;
    });

    const newPot = room.pot + additionalNeeded;
    const newIncrement = newTotalAmount - currentHighestBet;

    supabase
      .from("rooms")
      .update({
        pot: newPot,
        current_highest_bet: newTotalAmount,
        last_raise_increment: newIncrement,
      })
      .eq("id", roomId)
      .then(({ error }) => {
        if (!error) {
          processBettingRoundTransition(updatedPlayers, newTotalAmount);
          showToast(isAllInAction ? "Anda melakukan ALL-IN RAISE!" : `Anda me-raise taruhan ke ${formatRupiah(newTotalAmount)}`, "success");
          setShowRaisePanel(false);
          setRaiseInput("");
        }
      });
  };

  // Spectator State Checks
  const isSpectator = myPlayerIndex === -1 || myPlayer?.is_folded && room.current_phase === "WAITING";

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg-primary)", padding: "16px 12px 140px 12px" }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>

        {/* ── Toast Notification ── */}
        {toast && (
          <div className={`toast toast-${toast.type}`}>
            <span>{toast.type === "success" ? "✅" : toast.type === "error" ? "❌" : "ℹ️"}</span>
            <span>{toast.message}</span>
          </div>
        )}

        {/* ── Header ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="phase-badge phase-preflop" style={{ background: "rgba(37,99,235,0.15)", border: "1px solid rgba(37,99,235,0.4)", color: "#93c5fd" }}>
                🃏 Pemain
              </span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Room ID: {roomId.slice(0, 8)}...</span>
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 900, marginTop: 4 }}>{room.room_name}</h1>
          </div>
          <button className="btn-ghost" onClick={() => router.push("/")} style={{ fontSize: 12, padding: "8px 12px" }}>
            🚪 Lobby
          </button>
        </div>

        {/* ── Game State Overview Banner ── */}
        <div className="glass" style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 2 }}>
              Fase Game
            </div>
            <span className={`phase-badge phase-${room.current_phase.toLowerCase().replace("-", "")}`}>
              {room.current_phase}
            </span>
          </div>
          
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 2 }}>
              Total Pot
            </div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)" }}>
              {formatRupiah(room.pot)}
            </div>
          </div>
        </div>

        {/* ── My Balance & Contribution Card ── */}
        {myPlayer && (
          <div className="glass-gold" style={{ padding: 20, marginBottom: 20, background: "linear-gradient(135deg, rgba(17,24,39,0.85) 0%, rgba(20,28,47,0.85) 100%)", boxShadow: isMyTurn ? "0 0 25px rgba(250,204,21,0.2)" : "none" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
                  Pemain Aktif
                </div>
                <div style={{ fontSize: 22, fontWeight: 900, display: "flex", alignItems: "center", gap: 6 }}>
                  {myName}
                  {myPlayer.position !== "REGULAR" && (
                    <span style={{
                      background: myPlayer.position === "SB" ? "var(--emerald-check)" : "var(--orange-raise)",
                      fontSize: 10,
                      fontWeight: 900,
                      padding: "2px 6px",
                      borderRadius: 4,
                      color: "#fff"
                    }}>
                      {myPlayer.position}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
                  Status Anda
                </div>
                <div>
                  {myPlayer.is_folded ? (
                    <span className="phase-badge phase-waiting" style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.4)", color: "var(--red-fold)" }}>Folded ❌</span>
                  ) : myPlayer.is_all_in ? (
                    <span className="phase-badge phase-waiting" style={{ background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.4)", color: "#c084fc" }}>All-In 🍇</span>
                  ) : isMyTurn ? (
                    <span className="phase-badge phase-waiting" style={{ background: "rgba(250,204,21,0.15)", border: "1px solid var(--gold)", color: "var(--gold)", animation: "pulse 1.2s infinite" }}>GILIRAN ANDA 🔥</span>
                  ) : (
                    <span className="phase-badge phase-waiting">Aktif Waiting</span>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Saldo Anda:</div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-secondary)" }}>
                  {formatRupiah(myPlayer.current_balance)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Taruhan Ronde Ini:</div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--gold)" }}>
                  {formatRupiah(myPlayer.round_contribution)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── SPECTATOR BAR OR WAITING NOTICE ── */}
        {isSpectator && (
          <div className="glass" style={{ padding: 20, textAlign: "center", marginBottom: 20, border: "1px dashed var(--border-accent)" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>👀</div>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Mode Penonton (Spectator)</h3>
            <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
              Game sedang berjalan. Anda akan otomatis dimasukkan sebagai pemain aktif di ronde berikutnya saat dealer memulai ulang game (reset/payout).
            </p>
          </div>
        )}

        {/* ── TABLE OVERVIEW (OTHER PLAYERS STATUS) ── */}
        <div className="glass" style={{ padding: 18 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", marginBottom: 12 }}>
            Status Seluruh Pemain di Meja
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {players.map((p) => {
              const isMe = p.id === myId;
              const isTurn = p.is_current_turn && room.current_phase !== "WAITING" && room.current_phase !== "SHOWDOWN";

              let rowClass = "player-card";
              if (isTurn) rowClass += " is-active turn-pulse";
              if (p.is_folded) rowClass += " is-folded";
              if (p.is_all_in) rowClass += " is-allin";
              if (isMe) rowClass += " is-me";

              return (
                <div
                  key={p.id}
                  className={rowClass}
                  style={{
                    padding: "10px 14px",
                    background: isMe ? "rgba(37,99,235,0.03)" : "rgba(255,255,255,0.01)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ fontWeight: isMe ? 800 : 600, fontSize: 14, color: isMe ? "var(--gold)" : "#fff", display: "flex", alignItems: "center", gap: 4 }}>
                        {p.name} {isMe && "(Anda)"}
                        {p.position !== "REGULAR" && (
                          <span style={{ fontSize: 8, background: "rgba(255,255,255,0.1)", padding: "1px 4px", borderRadius: 3, opacity: 0.8 }}>
                            {p.position}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        Bal: <span className="mono">{formatRupiah(p.current_balance)}</span>
                      </span>
                    </div>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--gold)" }}>
                      {formatRupiah(p.round_contribution)}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                      {p.is_folded ? (
                        <span style={{ color: "var(--red-fold)" }}>FOLDED</span>
                      ) : p.is_all_in ? (
                        <span style={{ color: "var(--purple-dealer)" }}>ALL-IN</span>
                      ) : isTurn ? (
                        <span style={{ color: "var(--gold)", fontWeight: 700 }}>GILIRAN</span>
                      ) : p.has_acted ? (
                        <span style={{ color: "var(--emerald-check)" }}>ACTED</span>
                      ) : (
                        <span>WAITING</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── DYNAMIC ACTION CONTROL BAR ── */}
        {isMyTurn && myPlayer && !myPlayer.is_folded && !myPlayer.is_all_in && (
          <div className="bottom-bar" style={{ animation: "toast-in 0.2s ease" }}>
            <div style={{ maxWidth: 580, margin: "0 auto" }}>
              
              {/* Quick feedback header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, fontSize: 12, color: "var(--text-secondary)" }}>
                <div>
                  Fase: <strong style={{ color: "#fff" }}>{room.current_phase}</strong>
                </div>
                <div>
                  Bet Tertinggi: <strong className="mono" style={{ color: "var(--gold)" }}>{formatRupiah(currentHighestBet)}</strong>
                </div>
              </div>

              {/* Toggle Bet Panel */}
              {showBetPanel && (
                <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 12, marginBottom: 12, border: "1px solid var(--border-accent)" }}>
                  <label className="label">Nominal Taruhan (Min: {formatRupiah(room.big_blind)})</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="input-field"
                      type="number"
                      placeholder={String(room.big_blind)}
                      value={betInput}
                      onChange={(e) => setBetInput(e.target.value)}
                      style={{ flex: 1 }}
                      autoFocus
                    />
                    <button className="btn-primary" onClick={() => handleBet(parseInt(betInput) || 0)} style={{ padding: "10px 16px", fontSize: 13 }}>
                      Bet!
                    </button>
                    <button className="btn-ghost" onClick={() => { setShowBetPanel(false); setBetInput(""); }} style={{ padding: "10px" }}>
                      ❌
                    </button>
                  </div>
                  
                  {/* Quick Select Buttons */}
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {[room.big_blind, room.big_blind * 2, room.big_blind * 4, room.big_blind * 10, myPlayer.current_balance].map((val) => (
                      <button
                        key={val}
                        onClick={() => {
                          setBetInput(String(val));
                        }}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 6,
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          color: "var(--text-secondary)",
                          fontSize: 10,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {val === myPlayer.current_balance ? "ALL-IN" : formatRupiah(val)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Toggle Raise Panel */}
              {showRaisePanel && (
                <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 12, marginBottom: 12, border: "1px solid var(--border-accent)" }}>
                  <label className="label">Total Raise Baru (Min: {formatRupiah(currentHighestBet + room.last_raise_increment)})</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="input-field"
                      type="number"
                      placeholder={String(currentHighestBet + room.last_raise_increment)}
                      value={raiseInput}
                      onChange={(e) => setRaiseInput(e.target.value)}
                      style={{ flex: 1 }}
                      autoFocus
                    />
                    <button className="btn-primary" onClick={() => handleRaise(parseInt(raiseInput) || 0)} style={{ padding: "10px 16px", fontSize: 13 }}>
                      Raise!
                    </button>
                    <button className="btn-ghost" onClick={() => { setShowRaisePanel(false); setRaiseInput(""); }} style={{ padding: "10px" }}>
                      ❌
                    </button>
                  </div>
                  
                  {/* Quick Select Buttons */}
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {[
                      currentHighestBet + room.last_raise_increment,
                      currentHighestBet * 2,
                      currentHighestBet * 3,
                      myPlayer.current_balance + myPlayer.round_contribution
                    ].map((val) => {
                      const isAllInTotal = val >= myPlayer.current_balance + myPlayer.round_contribution;
                      const displayVal = isAllInTotal ? myPlayer.current_balance + myPlayer.round_contribution : val;
                      return (
                        <button
                          key={val}
                          onClick={() => {
                            setRaiseInput(String(displayVal));
                          }}
                          style={{
                            padding: "4px 8px",
                            borderRadius: 6,
                            background: "rgba(255,255,255,0.06)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            color: "var(--text-secondary)",
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          {isAllInTotal ? "ALL-IN" : formatRupiah(displayVal)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Action Buttons Grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {isConditionA ? (
                  <>
                    <button className="btn-action btn-check" onClick={handleCheck}>
                      🟢 CHECK
                    </button>
                    <button
                      className="btn-action btn-bet"
                      onClick={() => {
                        setShowBetPanel(!showBetPanel);
                        setShowRaisePanel(false);
                      }}
                    >
                      🟡 BET
                    </button>
                    <button className="btn-action btn-fold" onClick={handleFold}>
                      🔴 FOLD
                    </button>
                  </>
                ) : (
                  <>
                    {/* Call Button label indicates call difference or all-in */}
                    {(() => {
                      const diff = currentHighestBet - myPlayer.round_contribution;
                      const isAllInCall = diff >= myPlayer.current_balance;
                      return (
                        <button className={`btn-action ${isAllInCall ? "btn-allin" : "btn-call"}`} onClick={handleCall}>
                          {isAllInCall ? `🍇 ALL-IN (${formatRupiah(myPlayer.current_balance)})` : `🔵 CALL (${formatRupiah(diff)})`}
                        </button>
                      );
                    })()}
                    
                    <button
                      className="btn-action btn-raise"
                      onClick={() => {
                        setShowRaisePanel(!showRaisePanel);
                        setShowBetPanel(false);
                      }}
                    >
                      🟠 RAISE
                    </button>
                    
                    <button className="btn-action btn-fold" onClick={handleFold}>
                      🔴 FOLD
                    </button>
                  </>
                )}
              </div>

            </div>
          </div>
        )}

        {/* ── TURN INDICATOR PULSE BAR (WHEN NOT MY TURN) ── */}
        {!isMyTurn && myPlayer && !isSpectator && (
          <div className="bottom-bar" style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "16px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", fontWeight: 600 }}>
              <span className="turn-pulse" style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "var(--gold)" }}></span>
              {room.status === "paused" ? (
                <span>Menunggu dealer memulai babak berikutnya...</span>
              ) : (() => {
                const turnP = players.find((p) => p.is_current_turn);
                return turnP ? (
                  <span>Menunggu giliran <strong style={{ color: "var(--gold)" }}>{turnP.name}</strong>...</span>
                ) : (
                  <span>Menunggu game dimulai oleh dealer...</span>
                );
              })()}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
