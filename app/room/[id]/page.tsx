'use client';

import { useEffect, useState, use } from "react";
import { supabase } from "@/lib/supabase";

type Player = {
    name: string;
    chips: number;
    currentBet: number;
    isFolded: boolean;
};

type RoomData = {
    id: string;
    room_name: string;
    pot: number;
    players: Player[];
    status: 'waiting' | 'playing';
    current_turn: string | null;
    winner: string | null;
};

export default function PokerRoom({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = use(params);
    const roomId = resolvedParams.id;

    const [room, setRoom] = useState<RoomData | null>(null);
    const [playerName, setPlayerName] = useState('');
    const [hasJoined, setHasJoined] = useState(false);
    const [showWinnerModal, setShowWinnerModal] = useState(false);
    const [customBetAmount, setCustomBetAmount] = useState('');
    const [notification, setNotification] = useState<{ type: 'error' | 'success', message: string } | null>(null);

    useEffect(() => {
        const fetchRoom = async () => {
            const { data } = await supabase.from('rooms').select('*').eq('id', roomId).single();
            if (data) setRoom(data as RoomData);
        };
        fetchRoom();

        const channel = supabase
            .channel(`room-${roomId}`)
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
                (payload) => {
                    setRoom(payload.new as RoomData);
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [roomId]);

    const joinTable = async () => {
        if (!playerName || !room) return;

        if (room.players.find(p => p.name === playerName)) {
            setHasJoined(true);
            return;
        }

        const newPlayer: Player = { name: playerName, chips: 100000, currentBet: 0, isFolded: false };
        const updatedPlayers = [...room.players, newPlayer];

        await supabase.from('rooms').update({ players: updatedPlayers }).eq('id', roomId);
        setHasJoined(true);
    };

    const startGame = async () => {
        if (!room || room.status !== 'waiting' || room.players.length < 3) return;

        // Check if any player has 0 chips
        const playerWithZeroChips = room.players.find(p => p.chips <= 0);
        if (playerWithZeroChips) {
            setNotification({ type: 'error', message: `Player ${playerWithZeroChips.name} tidak punya chip cukup untuk mulai game!` });
            setTimeout(() => setNotification(null), 3000);
            return;
        }

        // Take $100 ante from everyone
        const anteAmount = 100;
        const updatedPlayers = room.players.map(p => ({
            ...p,
            chips: p.chips - anteAmount,
            currentBet: anteAmount,
            isFolded: false
        }));

        const newPot = anteAmount * room.players.length;
        const firstPlayer = updatedPlayers[0];

        await supabase.from('rooms').update({
            players: updatedPlayers,
            pot: newPot,
            status: 'playing',
            current_turn: firstPlayer.name
        }).eq('id', roomId);
    };


    const handleNextRound = async () => {
        if (!room || room.status !== 'playing') return;

        // Reset all players' current bets to 0
        const updatedPlayers = room.players.map(p => ({
            ...p,
            currentBet: 0
        }));

        // The first turn of the next round goes to the first active player
        let nextTurnIndex = 0;
        let attempts = 0;
        while (updatedPlayers[nextTurnIndex].isFolded && attempts < updatedPlayers.length) {
            nextTurnIndex = (nextTurnIndex + 1) % updatedPlayers.length;
            attempts++;
        }

        const nextPlayer = updatedPlayers[nextTurnIndex];

        await supabase.from('rooms').update({
            players: updatedPlayers,
            current_turn: nextPlayer ? nextPlayer.name : null
        }).eq('id', roomId);
    };

    const handleSelectWinner = async (winnerName: string) => {
        if (!room) return;

        const winnerPlayer = room.players.find(p => p.name === winnerName);
        if (!winnerPlayer) return;

        // Award pot to the winner and reset bets & fold statuses
        const updatedPlayers = room.players.map(p => {
            if (p.name === winnerName) {
                return { ...p, chips: p.chips + room.pot, currentBet: 0, isFolded: false };
            }
            return { ...p, currentBet: 0, isFolded: false };
        });

        await supabase.from('rooms').update({
            players: updatedPlayers,
            pot: 0,
            status: 'waiting',
            current_turn: null,
            winner: winnerName
        }).eq('id', roomId);

        setShowWinnerModal(false);
    };

    const handleRaise = async (amount: number) => {
        if (!room || room.status !== 'playing' || room.current_turn !== playerName) return;

        const myData = room.players.find(p => p.name === playerName);
        if (!myData || myData.chips < amount) {
            setNotification({ type: 'error', message: 'Chip tidak cukup!' });
            setTimeout(() => setNotification(null), 3000);
            return;
        }

        const updatedPlayers = room.players.map(p => {
            if (p.name === playerName) {
                return { ...p, chips: p.chips - amount, currentBet: p.currentBet + amount };
            }
            return p;
        });

        const newPot = room.pot + amount;

        // Check if betting round is complete (all active players have matched bets)
        const activePlayers = updatedPlayers.filter(p => !p.isFolded);
        const maxBet = Math.max(...activePlayers.map(p => p.currentBet));
        const allMatched = activePlayers.every(p => p.currentBet === maxBet);

        if (allMatched && activePlayers.length > 1) {
            // Betting round complete, reset bets for next round
            const playersWithResetBets = updatedPlayers.map(p => ({
                ...p,
                currentBet: 0
            }));

            const nextTurnIndex = 0;
            let nextTurn = nextTurnIndex;
            let attempts = 0;
            while (playersWithResetBets[nextTurn].isFolded && attempts < playersWithResetBets.length) {
                nextTurn = (nextTurn + 1) % playersWithResetBets.length;
                attempts++;
            }

            await supabase.from('rooms').update({
                players: playersWithResetBets,
                pot: newPot,
                current_turn: playersWithResetBets[nextTurn].name
            }).eq('id', roomId);
        } else {
            const nextTurnIndex = getNextTurnIndex(updatedPlayers);
            const nextPlayer = updatedPlayers[nextTurnIndex];

            await supabase.from('rooms').update({
                players: updatedPlayers,
                pot: newPot,
                current_turn: nextPlayer.name
            }).eq('id', roomId);
        }
    };

    const handleCustomBet = async () => {
        const amount = parseInt(customBetAmount);
        if (!amount || amount <= 0) return;

        // Validate minimum bet (must be at least current max bet)
        if (room) {
            const activePlayers = room.players.filter(p => !p.isFolded);
            const maxBet = Math.max(...activePlayers.map(p => p.currentBet));
            if (amount < maxBet) {
                setNotification({ type: 'error', message: `Minimum bet adalah $${maxBet}` });
                setTimeout(() => setNotification(null), 3000);
                return;
            }
        }

        await handleRaise(amount);
        setCustomBetAmount('');
    };

    const handleCheck = async () => {
        if (!room || room.status !== 'playing' || room.current_turn !== playerName) return;

        const activePlayers = room.players.filter(p => !p.isFolded);
        const maxBet = Math.max(...activePlayers.map(p => p.currentBet));
        const myData = room.players.find(p => p.name === playerName);

        // Can only check if current bet is 0 or matches the max bet
        if (!myData || myData.currentBet !== maxBet) return;

        const nextTurnIndex = getNextTurnIndex(room.players);
        const nextPlayer = room.players[nextTurnIndex];

        await supabase.from('rooms').update({
            current_turn: nextPlayer.name
        }).eq('id', roomId);
    };

    const handleCall = async () => {
        if (!room || room.status !== 'playing' || room.current_turn !== playerName) return;

        const activePlayers = room.players.filter(p => !p.isFolded);
        const maxBet = Math.max(...activePlayers.map(p => p.currentBet));
        const myData = room.players.find(p => p.name === playerName);

        if (!myData || myData.currentBet >= maxBet) return;

        const callAmount = maxBet - myData.currentBet;
        if (myData.chips < callAmount) {
            setNotification({ type: 'error', message: 'Chip tidak cukup untuk call!' });
            setTimeout(() => setNotification(null), 3000);
            return;
        }

        const updatedPlayers = room.players.map(p => {
            if (p.name === playerName) {
                return { ...p, chips: p.chips - callAmount, currentBet: maxBet };
            }
            return p;
        });

        const newPot = room.pot + callAmount;

        // Check if betting round is complete
        const allMatched = updatedPlayers.filter(p => !p.isFolded).every(p => p.currentBet === maxBet);

        if (allMatched && activePlayers.length > 1) {
            // Betting round complete, reset bets for next round
            const playersWithResetBets = updatedPlayers.map(p => ({
                ...p,
                currentBet: 0
            }));

            const nextTurnIndex = 0;
            let nextTurn = nextTurnIndex;
            let attempts = 0;
            while (playersWithResetBets[nextTurn].isFolded && attempts < playersWithResetBets.length) {
                nextTurn = (nextTurn + 1) % playersWithResetBets.length;
                attempts++;
            }

            await supabase.from('rooms').update({
                players: playersWithResetBets,
                pot: newPot,
                current_turn: playersWithResetBets[nextTurn].name
            }).eq('id', roomId);
        } else {
            const nextTurnIndex = getNextTurnIndex(updatedPlayers);
            const nextPlayer = updatedPlayers[nextTurnIndex];

            await supabase.from('rooms').update({
                players: updatedPlayers,
                pot: newPot,
                current_turn: nextPlayer.name
            }).eq('id', roomId);
        }
    };

    const handleAllIn = async () => {
        if (!room || room.status !== 'playing' || room.current_turn !== playerName) return;

        const myData = room.players.find(p => p.name === playerName);
        if (!myData || myData.chips <= 0) return;

        const allInAmount = myData.chips;

        const updatedPlayers = room.players.map(p => {
            if (p.name === playerName) {
                return { ...p, chips: 0, currentBet: p.currentBet + allInAmount };
            }
            return p;
        });

        const newPot = room.pot + allInAmount;

        // Check if betting round is complete
        const activePlayers = updatedPlayers.filter(p => !p.isFolded);
        const maxBet = Math.max(...activePlayers.map(p => p.currentBet));
        const allMatched = activePlayers.every(p => p.currentBet === maxBet || p.chips === 0);

        if (allMatched && activePlayers.length > 1) {
            // Betting round complete, reset bets for next round
            const playersWithResetBets = updatedPlayers.map(p => ({
                ...p,
                currentBet: 0
            }));

            const nextTurnIndex = 0;
            let nextTurn = nextTurnIndex;
            let attempts = 0;
            while (playersWithResetBets[nextTurn].isFolded && attempts < playersWithResetBets.length) {
                nextTurn = (nextTurn + 1) % playersWithResetBets.length;
                attempts++;
            }

            await supabase.from('rooms').update({
                players: playersWithResetBets,
                pot: newPot,
                current_turn: playersWithResetBets[nextTurn].name
            }).eq('id', roomId);
        } else {
            const nextTurnIndex = getNextTurnIndex(updatedPlayers);
            const nextPlayer = updatedPlayers[nextTurnIndex];

            await supabase.from('rooms').update({
                players: updatedPlayers,
                pot: newPot,
                current_turn: nextPlayer.name
            }).eq('id', roomId);
        }
    };

    const handleFold = async () => {
        if (!room || room.status !== 'playing' || room.current_turn !== playerName) return;

        const updatedPlayers = room.players.map(p => p.name === playerName ? { ...p, isFolded: true } : p);

        const activePlayers = updatedPlayers.filter(p => !p.isFolded);

        if (activePlayers.length === 1) {
            const winner = activePlayers[0];
            const updatedPlayersWithWinnings = updatedPlayers.map(p => {
                if (p.name === winner.name) {
                    return { ...p, chips: p.chips + room.pot, currentBet: 0, isFolded: false };
                }
                return { ...p, currentBet: 0, isFolded: false };
            });

            await supabase.from('rooms').update({
                players: updatedPlayersWithWinnings,
                pot: 0,
                status: 'waiting',
                current_turn: null,
                winner: winner.name
            }).eq('id', roomId);
        } else {
            const nextTurnIndex = getNextTurnIndex(updatedPlayers);
            const nextPlayer = updatedPlayers[nextTurnIndex];

            await supabase.from('rooms').update({
                players: updatedPlayers,
                current_turn: nextPlayer.name
            }).eq('id', roomId);
        }
    };

    const getNextTurnIndex = (players: Player[]): number => {
        if (!room || !room.current_turn) return 0;
        const currentIndex = players.findIndex(p => p.name === room.current_turn);
        let nextIndex = (currentIndex + 1) % players.length;
        
        // Skip folded players
        let attempts = 0;
        while (players[nextIndex].isFolded && attempts < players.length) {
            nextIndex = (nextIndex + 1) % players.length;
            attempts++;
        }
        
        return nextIndex;
    };

    const resetGame = async () => {
        if (!room) return;

        const updatedPlayers = room.players.map(p => ({
            ...p,
            currentBet: 0,
            isFolded: false
        }));

        await supabase.from('rooms').update({
            players: updatedPlayers,
            pot: 0,
            status: 'waiting',
            current_turn: null,
            winner: null
        }).eq('id', roomId);
    };

    if (!room) return <div className="p-10 text-white bg-slate-900 min-h-screen">Loading Table...</div>;

    if (!hasJoined) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-4">
                <div className="bg-slate-800/50 backdrop-blur-sm p-8 rounded-2xl w-full max-w-md shadow-2xl border border-slate-700">
                    <h1 className="text-3xl font-bold mb-2 text-center text-yellow-400">{room.room_name}</h1>
                    <p className="text-center text-slate-400 mb-6">Join meja untuk bermain</p>
                    <input
                        type="text"
                        placeholder="Masukkan Nama Kamu"
                        className="w-full p-4 rounded-xl bg-slate-700 mb-4 focus:outline-none focus:ring-2 focus:ring-yellow-500 text-white placeholder-slate-400"
                        value={playerName}
                        onChange={(e) => setPlayerName(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && joinTable()}
                    />
                    <button onClick={joinTable} className="w-full bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 p-4 rounded-xl font-bold text-black transition-all transform hover:scale-105">
                        Join Meja
                    </button>
                    <div className="mt-4 text-center text-slate-400 text-sm">
                        Players: {room.players.length} orang
                    </div>
                </div>
            </div>
        );
    }

    const myData = room.players.find(p => p.name === playerName);
    const isMyTurn = room.current_turn === playerName;

    return (
        <div className="min-h-screen bg-gradient-to-br from-green-900 via-green-800 to-green-900 text-white p-4 md:p-8 font-sans">
            <div className="max-w-4xl mx-auto pb-32 md:pb-8">

                {/* Room Header */}
                <div className="flex flex-col sm:flex-row justify-between items-center mb-6 gap-4">
                    <div>
                        <h1 className="text-2xl md:text-3xl font-bold text-yellow-400">{room.room_name}</h1>
                        <p className="text-slate-300 text-sm">
                            Status: <span className={`font-semibold ${room.status === 'waiting' ? 'text-green-400' : 'text-red-400'}`}>
                                {room.status === 'waiting' ? 'MENUNGGU' : 'BERMAIN'}
                            </span>
                        </p>
                    </div>
                    {room.status === 'waiting' && room.players.length >= 3 && (
                        <button
                            onClick={startGame}
                            className="px-6 py-3 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 rounded-xl font-bold text-black transition-all transform hover:scale-105 shadow-lg active:scale-95 animate-pulse"
                        >
                            🚀 Mulai Game
                        </button>
                    )}
                </div>

                {/* Winner Announcement */}
                {room.winner && (
                    <div className="bg-yellow-500/20 border-2 border-yellow-500 rounded-2xl p-6 mb-6 text-center">
                        <h2 className="text-3xl font-black text-yellow-400 mb-2">🎉 {room.winner} MENANG! 🎉</h2>
                        <p className="text-white">Mendapatkan ${room.pot}</p>
                        <button
                            onClick={resetGame}
                            className="mt-4 px-6 py-2 bg-yellow-500 hover:bg-yellow-400 rounded-lg font-bold text-black transition-all"
                        >
                            Main Lagi
                        </button>
                    </div>
                )}

                {/* Pot Info */}
                <div className="bg-green-800/50 backdrop-blur-sm border-4 border-green-700 rounded-full py-8 md:py-12 text-center my-6 md:my-8 shadow-2xl relative">
                    <p className="text-green-300 uppercase tracking-widest text-xs md:text-sm font-bold">Total Pot</p>
                    <p className="text-4xl md:text-6xl font-black text-yellow-400 drop-shadow-md">${room.pot}</p>
                </div>

                {/* Current Turn Info */}
                {room.status === 'playing' && room.current_turn && (
                    <div className="text-center mb-4">
                        <span className={`inline-block px-4 py-2 rounded-full text-sm font-semibold ${
                            isMyTurn ? 'bg-blue-600/30 border border-blue-500 animate-pulse' : 'bg-slate-600/30 border border-slate-500'
                        }`}>
                            {isMyTurn ? '🎯 GILIRAN KAMU!' : `⏳ Giliran: ${room.current_turn}`}
                        </span>
                    </div>
                )}

                {/* Players List */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4 mb-8">
                    {room.players.map((p: Player, idx: number) => (
                        <div key={idx} className={`p-4 rounded-xl shadow-lg border-l-4 transition-all ${
                            p.isFolded 
                                ? 'bg-slate-800/50 border-slate-600 opacity-60' 
                                : p.name === playerName 
                                    ? 'bg-slate-800/50 border-blue-500' 
                                    : 'bg-slate-800/50 border-green-500'
                        } ${room.current_turn === p.name && !p.isFolded ? 'ring-2 ring-yellow-400' : ''}`}>
                            <div className="flex justify-between items-start mb-2">
                                <h3 className="font-bold text-base md:text-lg">
                                    {p.name} 
                                    {p.name === playerName && ' (Kamu)'}
                                </h3>
                                {room.current_turn === p.name && !p.isFolded && (
                                    <span className="text-xs bg-yellow-500 text-black px-2 py-1 rounded font-bold">AKTIF</span>
                                )}
                            </div>
                            <p className="text-slate-400 text-sm">Sisa Chip: <span className="text-white font-mono">${p.chips}</span></p>
                            <p className="text-slate-400 text-sm">Bet: <span className="text-yellow-400 font-mono">${p.currentBet}</span></p>
                            {p.isFolded && <span className="inline-block mt-2 text-xs bg-red-900 text-red-300 px-2 py-1 rounded">FOLDED</span>}
                        </div>
                    ))}
                </div>

                {/* Waiting for players message */}
                {room.status === 'waiting' && room.players.length < 3 && (
                    <div className="text-center p-6 bg-slate-800/50 rounded-xl border border-slate-700">
                        <p className="text-slate-300">Menunggu player lain join... ({room.players.length}/3)</p>
                    </div>
                )}

            </div>

            {/* Player Controls (Fixed at bottom) */}
            {!myData?.isFolded && room.status === 'playing' && (
                <div className="bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 rounded-t-3xl fixed bottom-0 left-0 right-0 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
                    <div className="max-w-4xl mx-auto">
                        <div className="flex justify-between items-center mb-4">
                            <div>
                                <p className="text-xs md:text-sm text-slate-400">Chip Kamu</p>
                                <p className="text-xl md:text-2xl font-bold text-blue-400">${myData?.chips}</p>
                            </div>
                            <div>
                                <p className="text-xs md:text-sm text-slate-400">Bet Kamu</p>
                                <p className="text-xl md:text-2xl font-bold text-yellow-400">${myData?.currentBet}</p>
                            </div>
                        </div>

                        <div className={`grid grid-cols-2 md:grid-cols-5 gap-2 ${!isMyTurn ? 'opacity-50 pointer-events-none' : ''}`}>
                            <button 
                                onClick={handleCheck} 
                                className="bg-green-600 hover:bg-green-500 py-3 md:py-4 rounded-lg font-bold text-sm md:text-base transition-all"
                                disabled={!isMyTurn}
                            >
                                CHECK
                            </button>
                            <button 
                                onClick={handleCall} 
                                className="bg-blue-600 hover:bg-blue-500 py-3 md:py-4 rounded-lg font-bold text-sm md:text-base transition-all"
                                disabled={!isMyTurn}
                            >
                                CALL
                            </button>
                            <button 
                                onClick={() => handleRaise(100)} 
                                className="bg-blue-600 hover:bg-blue-500 py-3 md:py-4 rounded-lg font-bold text-sm md:text-base transition-all"
                                disabled={!isMyTurn}
                            >
                                + $100
                            </button>
                            <button 
                                onClick={() => handleRaise(500)} 
                                className="bg-blue-600 hover:bg-blue-500 py-3 md:py-4 rounded-lg font-bold text-sm md:text-base transition-all"
                                disabled={!isMyTurn}
                            >
                                + $500
                            </button>
                            <button 
                                onClick={handleAllIn} 
                                className="bg-purple-600 hover:bg-purple-500 py-3 md:py-4 rounded-lg font-bold text-sm md:text-base transition-all"
                                disabled={!isMyTurn}
                            >
                                ALL-IN
                            </button>
                            <button 
                                onClick={handleFold} 
                                className="bg-red-600 hover:bg-red-500 py-3 md:py-4 rounded-lg font-bold text-sm md:text-base transition-all col-span-2 md:col-span-1"
                                disabled={!isMyTurn}
                            >
                                FOLD
                            </button>
                        </div>

                        {/* Custom Bet Input */}
                        <div className={`mt-3 flex gap-2 ${!isMyTurn ? 'opacity-50 pointer-events-none' : ''}`}>
                            <input
                                type="number"
                                placeholder="Custom bet..."
                                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-yellow-500"
                                value={customBetAmount}
                                onChange={(e) => setCustomBetAmount(e.target.value)}
                                onKeyPress={(e) => e.key === 'Enter' && handleCustomBet()}
                                disabled={!isMyTurn}
                            />
                            <button
                                onClick={handleCustomBet}
                                className="bg-yellow-500 hover:bg-yellow-400 text-black px-6 py-3 rounded-lg font-bold transition-all"
                                disabled={!isMyTurn}
                            >
                                BET
                            </button>
                        </div>

                        {!isMyTurn && (
                            <p className="text-center text-slate-400 text-xs mt-2">Tunggu giliran kamu</p>
                        )}
                    </div>
                </div>
            )}

            {/* Notification */}
            {notification && (
                <div className={`fixed top-4 right-4 px-6 py-4 rounded-xl shadow-2xl z-50 ${
                    notification.type === 'error' ? 'bg-red-600' : 'bg-green-600'
                }`}>
                    <p className="text-white font-semibold">{notification.message}</p>
                </div>
            )}

            {/* Showdown Winner Selection Modal */}
            {showWinnerModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in">
                    <div className="bg-slate-800 border border-slate-700 rounded-3xl p-6 w-full max-w-md shadow-2xl relative animate-scale-up">
                        <button
                            onClick={() => setShowWinnerModal(false)}
                            className="absolute top-4 right-4 text-slate-400 hover:text-white text-xl"
                        >
                            ✕
                        </button>
                        <h3 className="text-xl font-bold text-yellow-400 mb-2 flex items-center gap-2">
                            🏆 Tentukan Pemenang Pot
                        </h3>
                        <p className="text-slate-300 text-xs md:text-sm mb-6 leading-relaxed border-b border-slate-700/50 pb-3">
                            Pilih player yang memenangkan showdown di dunia nyata. Total Pot sebesar <strong className="text-yellow-400">${room.pot.toLocaleString()}</strong> akan dihadiahkan kepadanya.
                        </p>
                        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                            {room.players.filter((p: Player) => !p.isFolded).map((p: Player, idx: number) => (
                                <button
                                    key={idx}
                                    onClick={() => handleSelectWinner(p.name)}
                                    className="w-full text-left bg-slate-700/50 hover:bg-yellow-500 hover:text-black py-3 px-4 rounded-xl font-bold text-white transition-all transform hover:scale-[1.02] flex justify-between items-center border border-slate-600/30 hover:border-yellow-500"
                                >
                                    <span>{p.name} {p.name === playerName && '(Kamu)'}</span>
                                    <span className="font-mono text-xs opacity-80">Sisa: ${p.chips.toLocaleString()}</span>
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => setShowWinnerModal(false)}
                            className="w-full mt-6 bg-slate-700 hover:bg-slate-600 py-3 rounded-xl font-semibold text-slate-300 transition-all text-sm"
                        >
                            Kembali
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};