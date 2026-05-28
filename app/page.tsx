'use client';

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { formatRupiah } from "@/lib/poker-logic";
import type { RoomData } from "@/lib/poker-logic";

export default function Home() {
    const router = useRouter();
    const [rooms, setRooms] = useState<RoomData[]>([]);
    const [newRoomName, setNewRoomName] = useState('');
    const [loading, setLoading] = useState(true);
    const [showJoinModal, setShowJoinModal] = useState<RoomData | null>(null);
    const [joinName, setJoinName] = useState('');
    const [joinBalance, setJoinBalance] = useState('500000');
    const [joinRole, setJoinRole] = useState<'player' | 'dealer'>('player');
    const [creating, setCreating] = useState(false);

    const fetchRooms = async () => {
        const { data } = await supabase.from('rooms').select('*');
        if (data) setRooms(data as RoomData[]);
        setLoading(false);
    };

    useEffect(() => {
        fetchRooms();
        const channel = supabase
            .channel('rooms-lobby')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, fetchRooms)
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, []);

    const createRoom = async () => {
        if (!newRoomName.trim() || creating) return;
        setCreating(true);
        try {
            const { data, error } = await supabase
                .from('rooms')
                .insert({
                    room_name: newRoomName.trim(),
                    players: [],
                    pot: 0,
                    status: 'waiting',
                    current_turn: null,
                    dealer_index: -1,
                    winner: null,
                    current_phase: 'WAITING',
                    current_highest_bet: 0,
                    last_raise_increment: 0,
                    small_blind: 0,
                    big_blind: 0,
                    sb_index: 0,
                    bb_index: 1,
                })
                .select()
                .single();
            if (error) {
                console.error('Gagal membuat room:', error);
                alert('Gagal membuat room: ' + error.message);
            } else if (data) {
                setNewRoomName('');
                setShowJoinModal(data as RoomData);
            }
        } catch (err) {
            console.error('Error creating room:', err);
            alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'));
        } finally {
            setCreating(false);
        }
    };

    const handleJoinConfirm = () => {
        if (!showJoinModal || !joinName.trim()) return;
        const bal = parseInt(joinBalance) || 500000;
        localStorage.setItem('vi_name', joinName.trim());
        localStorage.setItem('vi_balance', String(bal));
        localStorage.setItem('vi_role', joinRole);
        router.push(`/room/${showJoinModal.id}`);
    };

    const openJoinModal = (room: RoomData) => {
        const savedName = localStorage.getItem('vi_name') || '';
        const savedBalance = localStorage.getItem('vi_balance') || '500000';
        setJoinName(savedName);
        setJoinBalance(savedBalance);
        setJoinRole('player');
        setShowJoinModal(room);
    };

    const phaseLabel = (phase: string) => {
        const map: Record<string, string> = {
            WAITING: 'Menunggu', 'PRE-FLOP': 'Pre-Flop',
            FLOP: 'Flop', TURN: 'Turn', RIVER: 'River', SHOWDOWN: 'Showdown',
        };
        return map[phase] ?? phase;
    };

    return (
        <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)', padding: '24px 16px' }}>
            <div style={{ maxWidth: 700, margin: '0 auto' }}>

                {/* ── Header ── */}
                <div style={{ textAlign: 'center', marginBottom: 40 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.15em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>
                        Virtual Chip Manager
                    </div>
                    <h1 style={{
                        fontSize: 'clamp(36px, 8vw, 60px)', fontWeight: 900,
                        background: 'linear-gradient(135deg, #facc15, #f97316)',
                        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text', lineHeight: 1.1, marginBottom: 10,
                    }}>VI-CHIP</h1>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 15 }}>
                        Texas Hold&apos;em Poker · Chip Management System
                    </p>
                </div>

                {/* ── Create Room ── */}
                <div className="glass" style={{ padding: 24, marginBottom: 24 }}>
                    <h2 style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 14 }}>
                        Buat Room Baru
                    </h2>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <input
                            className="input-field"
                            placeholder="Nama Room (contoh: Meja Jumat)"
                            value={newRoomName}
                            onChange={e => setNewRoomName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && createRoom()}
                            style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontWeight: 500 }}
                        />
                        <button
                            className="btn-primary"
                            onClick={createRoom}
                            disabled={creating || !newRoomName.trim()}
                            suppressHydrationWarning
                            style={{ whiteSpace: 'nowrap', fontSize: 14 }}
                        >
                            {creating ? '...' : '+ Buat'}
                        </button>
                    </div>
                </div>

                {/* ── Room List ── */}
                <div className="glass" style={{ padding: 24 }}>
                    <h2 style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 16 }}>
                        Daftar Room
                    </h2>

                    {loading ? (
                        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '32px 0' }}>Memuat...</div>
                    ) : rooms.length === 0 ? (
                        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0' }}>
                            <div style={{ fontSize: 40, marginBottom: 12 }}>🃏</div>
                            <p>Belum ada room. Buat room baru di atas!</p>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {rooms.map(room => {
                                const playerCount = Array.isArray(room.players) ? room.players.length : 0;
                                const phase = room.current_phase || 'WAITING';
                                const isPlaying = room.status === 'playing' || room.status === 'paused';
                                return (
                                    <div
                                        key={room.id}
                                        className="player-card"
                                        style={{
                                            padding: '16px 20px',
                                            background: 'rgba(255,255,255,0.03)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: 12,
                                            cursor: 'pointer',
                                        }}
                                        onClick={() => openJoinModal(room)}
                                    >
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {room.room_name}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                    👥 {playerCount} pemain
                                                </span>
                                                {isPlaying && (
                                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                        · 💰 Pot: {formatRupiah(room.pot || 0)}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <span className={`phase-badge phase-${phase.toLowerCase().replace('-','')}`}>
                                                {phaseLabel(phase)}
                                            </span>
                                            <span style={{ fontSize: 13, color: 'var(--gold)', fontWeight: 700 }}>
                                                Join →
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Join Modal ── */}
            {showJoinModal && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowJoinModal(null); }}>
                    <div className="modal-box">
                        <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>
                            {showJoinModal.room_name}
                        </h2>
                        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
                            Masukkan detail Anda untuk bergabung ke meja
                        </p>

                        {/* Role selection */}
                        <label className="label">Masuk Sebagai</label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                            {(['player', 'dealer'] as const).map(role => (
                                <button
                                    key={role}
                                    onClick={() => setJoinRole(role)}
                                    style={{
                                        padding: '14px 12px',
                                        borderRadius: 12,
                                        border: joinRole === role ? '2px solid var(--gold)' : '1.5px solid var(--border-subtle)',
                                        background: joinRole === role ? 'rgba(250,204,21,0.1)' : 'rgba(255,255,255,0.03)',
                                        color: joinRole === role ? 'var(--gold)' : 'var(--text-secondary)',
                                        fontWeight: 700,
                                        fontSize: 14,
                                        cursor: 'pointer',
                                        textAlign: 'center',
                                        transition: 'all 0.15s',
                                    }}
                                >
                                    {role === 'player' ? '🃏 Pemain' : '🎰 Dealer'}
                                    <div style={{ fontSize: 11, fontWeight: 400, marginTop: 4, opacity: 0.75 }}>
                                        {role === 'player' ? 'Ikut bertaruh' : 'Pantau & kontrol'}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <label className="label">Nama Anda</label>
                        <input
                            className="input-field"
                            placeholder={joinRole === 'dealer' ? 'Nama Dealer' : 'Nama Pemain'}
                            value={joinName}
                            onChange={e => setJoinName(e.target.value)}
                            style={{ marginBottom: 16, fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
                            autoFocus
                        />

                        {joinRole === 'player' && (
                            <>
                                <label className="label">Saldo Awal (Rp)</label>
                                <input
                                    className="input-field"
                                    type="number"
                                    placeholder="500000"
                                    value={joinBalance}
                                    onChange={e => setJoinBalance(e.target.value)}
                                    style={{ marginBottom: 16 }}
                                />
                                <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                                    {[100000, 250000, 500000, 1000000].map(v => (
                                        <button
                                            key={v}
                                            onClick={() => setJoinBalance(String(v))}
                                            style={{
                                                padding: '6px 12px',
                                                borderRadius: 8,
                                                background: joinBalance === String(v) ? 'rgba(250,204,21,0.2)' : 'rgba(255,255,255,0.05)',
                                                border: joinBalance === String(v) ? '1px solid var(--gold)' : '1px solid var(--border-subtle)',
                                                color: joinBalance === String(v) ? 'var(--gold)' : 'var(--text-muted)',
                                                fontSize: 12,
                                                fontWeight: 700,
                                                cursor: 'pointer',
                                                fontFamily: 'JetBrains Mono, monospace',
                                            }}
                                        >
                                            {formatRupiah(v)}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}

                        <button
                            className="btn-primary"
                            onClick={handleJoinConfirm}
                            disabled={!joinName.trim()}
                            style={{ width: '100%', fontSize: 15 }}
                        >
                            Masuk ke Meja →
                        </button>
                        <button className="btn-ghost" onClick={() => setShowJoinModal(null)}
                            style={{ width: '100%', marginTop: 10, fontSize: 13 }}>
                            Batal
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
