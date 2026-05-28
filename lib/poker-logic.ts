// ============================================================
// VI-CHIP — Pure Poker Logic (No side effects, no Supabase)
// ============================================================

export type PlayerPosition = 'SB' | 'BB' | 'REGULAR';
export type GamePhase = 'WAITING' | 'PRE-FLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';

export type Player = {
  id: string;
  name: string;
  current_balance: number;
  round_contribution: number;      // chip dimasukkan di fase berjalan
  total_game_contribution: number; // total dari pre-flop sampai sekarang
  is_folded: boolean;
  is_all_in: boolean;
  position: PlayerPosition;
  is_current_turn: boolean;
  has_acted: boolean;              // sudah bertindak di fase ini?
};

export type RoomData = {
  id: string;
  room_name: string;
  status: 'waiting' | 'playing' | 'paused';
  current_phase: GamePhase;
  pot: number;                     // total_pot
  current_highest_bet: number;
  last_raise_increment: number;
  small_blind: number;
  big_blind: number;
  sb_index: number;
  bb_index: number;
  dealer_index: number;
  players: Player[];
  winner: string | null;
  name: string | null;             // legacy field
  current_turn: string | null;     // current player name (legacy compat)
};

// ─────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// ─────────────────────────────────────────────
// MODULE 4 — MINIMUM RAISE VALIDATION
// ─────────────────────────────────────────────

export function validateRaise(
  inputTotal: number,          // total taruhan baru yang diinginkan player
  currentHighestBet: number,
  lastRaiseIncrement: number
): { valid: boolean; minRequired: number } {
  const minRequired = currentHighestBet + lastRaiseIncrement;
  return {
    valid: inputTotal >= minRequired,
    minRequired,
  };
}

/**
 * Setelah raise berhasil, hitung nilai increment baru.
 * increment = selisih antara taruhan baru vs taruhan tertinggi sebelumnya.
 */
export function computeNewIncrement(
  newTotalBet: number,
  previousHighestBet: number
): number {
  return newTotalBet - previousHighestBet;
}

// ─────────────────────────────────────────────
// MODULE 5 — BETTING ROUND TERMINATION
// ─────────────────────────────────────────────

export function isBettingRoundComplete(
  players: Player[],
  currentHighestBet: number
): boolean {
  // Pemain yang masih aktif (tidak fold & tidak all-in)
  const activePlayers = players.filter(p => !p.is_folded && !p.is_all_in);

  if (activePlayers.length === 0) return true;

  // Syarat 1: semua sudah bertindak minimal sekali
  const allActed = activePlayers.every(p => p.has_acted);

  // Syarat 2: semua round_contribution sama dengan taruhan tertinggi
  const allEqualized = activePlayers.every(
    p => p.round_contribution === currentHighestBet
  );

  return allActed && allEqualized;
}

// ─────────────────────────────────────────────
// MODULE 6 — PAYOUT CALCULATION (9% TAX)
// ─────────────────────────────────────────────

export type PayoutResult = {
  totalPot: number;
  tax: number;
  netPot: number;
  perWinner: number;
  remainder: number; // sisa dari pembagian yang tidak rata
};

export function calculatePayout(totalPot: number, winnerCount: number): PayoutResult {
  const tax = Math.floor(totalPot * 0.09);
  const netPot = totalPot - tax;
  const perWinner = Math.floor(netPot / winnerCount);
  const remainder = netPot - perWinner * winnerCount;
  return { totalPot, tax, netPot, perWinner, remainder };
}

// ─────────────────────────────────────────────
// TURN MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Cari indeks player berikutnya yang aktif (tidak fold, tidak all-in).
 * Mulai dari currentIndex+1 searah jarum jam.
 */
export function getNextActiveIndex(
  players: Player[],
  currentIndex: number
): number | null {
  const total = players.length;
  for (let i = 1; i <= total; i++) {
    const nextIdx = (currentIndex + i) % total;
    const p = players[nextIdx];
    if (!p.is_folded && !p.is_all_in) {
      return nextIdx;
    }
  }
  return null; // semua fold atau all-in
}

/**
 * Cek apakah hanya ada 1 pemain yang tidak fold.
 * Jika ya, pemain itu menang otomatis.
 */
export function getAutoWinner(players: Player[]): Player | null {
  const active = players.filter(p => !p.is_folded);
  if (active.length === 1) return active[0];
  return null;
}

// ─────────────────────────────────────────────
// PHASE RESET — Reset state pemain untuk fase baru
// ─────────────────────────────────────────────

export function resetPlayersForNewPhase(players: Player[]): Player[] {
  return players.map(p => ({
    ...p,
    round_contribution: 0,
    has_acted: false,
    is_current_turn: false,
  }));
}

/**
 * Reset penuh untuk ronde baru (tangan baru).
 * Hanya dipanggil setelah payout selesai.
 */
export function resetPlayersForNewHand(players: Player[]): Player[] {
  return players.map(p => ({
    ...p,
    round_contribution: 0,
    total_game_contribution: 0,
    is_folded: false,
    is_all_in: false,
    position: 'REGULAR' as PlayerPosition,
    is_current_turn: false,
    has_acted: false,
  }));
}

// ─────────────────────────────────────────────
// GAME PHASE SEQUENCE
// ─────────────────────────────────────────────

const PHASE_SEQUENCE: GamePhase[] = [
  'PRE-FLOP',
  'FLOP',
  'TURN',
  'RIVER',
  'SHOWDOWN',
];

export function getNextPhase(current: GamePhase): GamePhase {
  const idx = PHASE_SEQUENCE.indexOf(current);
  if (idx === -1 || idx === PHASE_SEQUENCE.length - 1) return 'SHOWDOWN';
  return PHASE_SEQUENCE[idx + 1];
}

// ─────────────────────────────────────────────
// BLIND SETUP
// ─────────────────────────────────────────────

/**
 * Assign posisi SB/BB ke player array sesuai indeks.
 */
export function assignBlinds(
  players: Player[],
  sbIndex: number,
  bbIndex: number
): Player[] {
  return players.map((p, idx) => {
    if (idx === sbIndex) return { ...p, position: 'SB' };
    if (idx === bbIndex) return { ...p, position: 'BB' };
    return { ...p, position: 'REGULAR' };
  });
}

/**
 * Rotate SB dan BB ke depan untuk ronde berikutnya.
 */
export function rotateBlindIndices(
  sbIndex: number,
  bbIndex: number,
  playerCount: number
): { newSbIndex: number; newBbIndex: number } {
  return {
    newSbIndex: (sbIndex + 1) % playerCount,
    newBbIndex: (bbIndex + 1) % playerCount,
  };
}
