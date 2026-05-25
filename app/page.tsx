'use client';

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type Player = {
    name: string;
    chips: number;
    currentBet: number;
    isFolded: boolean;
};

type Room = {
    id: string;
    room_name: string;
    players: Player[];
    pot: number;
    status: 'waiting' | 'playing';
    dealer_index: number;
};

export default function Home() {
    const router = useRouter();
    const [rooms, setRooms] = useState<Room[]>([]);
    const [newRoomName, setNewRoomName] = useState('');
    const [loading, setLoading] = useState(true);

    const fetchRooms = async () => {
        const { data } = await supabase.from('rooms').select('*');
        if (data) setRooms(data as Room[]);
        setLoading(false);
    };

    useEffect(() => {
        const fetchRoomsAsync = async () => {
            await fetchRooms();
        };
        fetchRoomsAsync();

        const channel = supabase
            .channel('rooms-changes')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'rooms' },
                () => fetchRooms()
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, []);

    const createRoom = async () => {
        if (!newRoomName.trim()) return;

        const { data, error } = await supabase
            .from('rooms')
            .insert({
                room_name: newRoomName,
                players: [],
                pot: 0,
                status: 'waiting',
                current_turn: null,
                dealer_index: -1,
                winner: null
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating room:', error);
            return;
        }

        if (data) {
            setNewRoomName('');
            router.push(`/room/${data.id}`);
        }
    };

    const joinRoom = (roomId: string) => {
        router.push(`/room/${roomId}`);
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                {/* Header */}
                <div className="text-center mb-8 md:mb-12">
                    <h1 className="text-4xl md:text-6xl font-black mb-4 bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">
                        VI-CHIP POKER
                    </h1>
                    <p className="text-slate-400 text-lg md:text-xl">Pilih room atau buat room baru untuk bermain</p>
                </div>

                {/* Create Room Section */}
                <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 md:p-8 mb-8 border border-slate-700">
                    <h2 className="text-2xl font-bold mb-4 text-yellow-400">Buat Room Baru</h2>
                    <div className="flex flex-col sm:flex-row gap-4">
                        <input
                            type="text"
                            placeholder="Nama Room..."
                            className="flex-1 p-4 rounded-xl bg-slate-700 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-yellow-500 text-white placeholder-slate-400"
                            value={newRoomName}
                            onChange={(e) => setNewRoomName(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && createRoom()}
                        />
                        <button
                            onClick={createRoom}
                            className="px-8 py-4 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 rounded-xl font-bold text-black transition-all transform hover:scale-105"
                        >
                            Buat Room
                        </button>
                    </div>
                </div>

                {/* Room List */}
                <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 md:p-8 border border-slate-700">
                    <h2 className="text-2xl font-bold mb-6 text-yellow-400">Daftar Room</h2>
                    
                    {loading ? (
                        <div className="text-center text-slate-400 py-8">Memuat rooms...</div>
                    ) : rooms.length === 0 ? (
                        <div className="text-center text-slate-400 py-8">Belum ada room. Buat room baru!</div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {rooms.map((room) => (
                                <div
                                    key={room.id}
                                    className="bg-slate-700/50 rounded-xl p-5 border border-slate-600 hover:border-yellow-500 transition-all cursor-pointer group"
                                    onClick={() => joinRoom(room.id)}
                                >
                                    <div className="flex justify-between items-start mb-3">
                                        <h3 className="text-xl font-bold text-white group-hover:text-yellow-400 transition-colors">
                                            {room.room_name}
                                        </h3>
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                                            room.status === 'waiting' 
                                                ? 'bg-green-500/20 text-green-400' 
                                                : 'bg-red-500/20 text-red-400'
                                        }`}>
                                            {room.status === 'waiting' ? 'MENUNGGU' : 'BERMAIN'}
                                        </span>
                                    </div>
                                    <div className="space-y-2 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Players:</span>
                                            <span className="text-white font-semibold">{room.players.length} orang</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Pot:</span>
                                            <span className="text-yellow-400 font-semibold">${room.pot}</span>
                                        </div>
                                    </div>
                                    <button className="w-full mt-4 py-2 bg-slate-600 hover:bg-yellow-500 hover:text-black rounded-lg font-semibold transition-all">
                                        Join Room
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
