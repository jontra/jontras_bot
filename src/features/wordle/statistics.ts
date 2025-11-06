import { getWordleDay, positiveGuesses } from './parser'
import type { AverageTimeStats, Leaderboard, WordleResult } from './types'

const SECONDS_IN_DAY = 24 * 60 * 60

export function getParticipants(results: WordleResult[]): string[] {
    return [...new Set(results.map((result) => result.playerId))]
}

export function getScores(results: WordleResult[]): Leaderboard {
    const bestPerDay = new Map<number, { guesses: number; winners: Set<string> }>()

    for (const result of results) {
        if (result.guesses === -1) continue
        const day = result.wordleDay
        const existing = bestPerDay.get(day)
        if (!existing || result.guesses < existing.guesses) {
            bestPerDay.set(day, { guesses: result.guesses, winners: new Set([result.playerId]) })
            continue
        }
        if (result.guesses === existing.guesses) {
            existing.winners.add(result.playerId)
        }
    }

    const leaderboard: Leaderboard = {}

    for (const { winners } of bestPerDay.values()) {
        const weight = winners.size > 0 ? 1 / winners.size : 0
        for (const playerId of winners) {
            leaderboard[playerId] = (leaderboard[playerId] ?? 0) + weight
        }
    }

    return leaderboard
}

export function getWeeklyScores(results: WordleResult[], startWordleDay: number, windowSize = 7): Leaderboard {
    const endWordleDay = startWordleDay + windowSize - 1
    const range = results.filter((result) => result.wordleDay >= startWordleDay && result.wordleDay <= endWordleDay)
    return getScores(range)
}

export function getWeeklyScoresNow(results: WordleResult[], referenceDate: Date = new Date()): Leaderboard {
    const startDay = getWordleDay(startOfWeek(referenceDate))
    return getWeeklyScores(results, startDay)
}

export function getAverages(results: WordleResult[]): Leaderboard {
    const leaderboard: Leaderboard = {}
    const counts: Record<string, number> = {}

    for (const result of results) {
        const value = positiveGuesses(result.guesses)
        leaderboard[result.playerId] = (leaderboard[result.playerId] ?? 0) + value
        counts[result.playerId] = (counts[result.playerId] ?? 0) + 1
    }

    for (const playerId of Object.keys(leaderboard)) {
        const total = leaderboard[playerId]
        const count = counts[playerId] ?? 1
        leaderboard[playerId] = Number((total / count).toFixed(2))
    }

    return leaderboard
}

export function getDayLeaderboards(results: WordleResult[], wordleDay: number): Leaderboard {
    const filtered = results.filter((result) => result.wordleDay === wordleDay && result.guesses !== -1)
    const leaderboard: Leaderboard = {}
    for (const result of filtered) {
        leaderboard[result.playerId] = result.guesses
    }
    return leaderboard
}

export function getDayLeaderboardsMulti(
    results: WordleResult[],
    wordleDay: number,
): Array<{ guesses: number; playerIds: string[] }> {
    const filtered = results.filter((result) => result.wordleDay === wordleDay && result.guesses !== -1)
    const map = new Map<number, Set<string>>()

    for (const result of filtered) {
        if (!map.has(result.guesses)) {
            map.set(result.guesses, new Set())
        }
        map.get(result.guesses)!.add(result.playerId)
    }

    return [...map.entries()]
        .map(([guesses, playerSet]) => ({
            guesses,
            playerIds: [...playerSet],
        }))
        .sort((a, b) => a.guesses - b.guesses)
}

export function getAverageTime(results: WordleResult[], playerId: string): AverageTimeStats {
    const playerResults = results.filter((result) => result.playerId === playerId)
    if (playerResults.length === 0) {
        return { avg: 0, std: 0 }
    }

    const values = playerResults.map((result) => Math.min(result.secondsSinceMidnight, SECONDS_IN_DAY - 1))
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length
    return { avg, std: Math.sqrt(variance) }
}

export function getPlayersPassed(oldBoard: Leaderboard, newBoard: Leaderboard): Record<string, string[]> {
    const passed: Record<string, string[]> = {}
    const players = new Set([...Object.keys(oldBoard), ...Object.keys(newBoard)])

    for (const player of players) {
        for (const other of players) {
            if (player === other) continue

            const oldPlayerScore = oldBoard[player] ?? 0
            const oldOtherScore = oldBoard[other] ?? 0
            const newPlayerScore = newBoard[player] ?? 0
            const newOtherScore = newBoard[other] ?? 0

            if (oldPlayerScore <= oldOtherScore && newPlayerScore > newOtherScore) {
                if (!passed[player]) {
                    passed[player] = []
                }
                passed[player].push(other)
            }
        }
    }

    return passed
}

export function buildLeaderboardString(board: Leaderboard, awards: string[] = ['🥇', '🥈', '🥉'], unit = 'pts.') {
    const entries = Object.entries(board)
        .sort((a, b) => b[1] - a[1])
        .map(([playerId, value], index) => {
            const medal = awards[index] ?? `${index + 1}.`
            return `${medal} ${playerId}: ${value.toFixed(2)} ${unit}`
        })
    return entries.join('\n')
}

function startOfWeek(reference: Date): Date {
    const date = new Date(reference)
    const day = date.getDay()
    const diff = date.getDate() - day
    date.setDate(diff)
    date.setHours(0, 0, 0, 0)
    return date
}
