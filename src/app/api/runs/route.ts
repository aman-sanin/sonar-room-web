import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/runs — fastest successful escapes (global leaderboard).
export async function GET() {
  try {
    const escapes = await db.run.findMany({
      where: { outcome: 'escaped' },
      orderBy: { timeMs: 'asc' },
      take: 5,
    })
    return NextResponse.json({
      escapes: escapes.map((r) => ({
        timeMs: r.timeMs,
        pings: r.pings,
        keysFound: r.keysFound,
        createdAt: r.createdAt,
      })),
    })
  } catch {
    return NextResponse.json({ escapes: [] })
  }
}

// POST /api/runs — record a finished run (escape or death).
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      outcome?: string
      timeMs?: number
      keysFound?: number
      pings?: number
    }
    const outcome = body.outcome === 'escaped' ? 'escaped' : 'caught'
    const timeMs = Math.max(0, Math.min(3_600_000, Math.round(Number(body.timeMs) || 0)))
    const keysFound = Math.max(0, Math.min(3, Math.round(Number(body.keysFound) || 0)))
    const pings = Math.max(0, Math.min(9999, Math.round(Number(body.pings) || 0)))
    const run = await db.run.create({ data: { outcome, timeMs, keysFound, pings } })
    return NextResponse.json({ ok: true, id: run.id })
  } catch {
    return NextResponse.json({ ok: false })
  }
}
