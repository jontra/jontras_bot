export interface WordleResult {
    wordleDay: number
    guesses: number
    hardMode: boolean
    grid: string
    playerId: string
    secondsSinceMidnight: number
    submittedAt: Date
}

export type Leaderboard = Record<string, number>

export interface AverageTimeStats {
    avg: number
    std: number
}
