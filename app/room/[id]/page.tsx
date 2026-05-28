'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function RoomRouter({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();

    useEffect(() => {
        const role = localStorage.getItem('vi_role') || 'player';
        if (role === 'dealer') {
            router.replace(`/room/${id}/dealer`);
        } else {
            router.replace(`/room/${id}/player`);
        }
    }, [id, router]);

    return (
        <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 15 }}>Memasuki meja...</div>
        </div>
    );
}