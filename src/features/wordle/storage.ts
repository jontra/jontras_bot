import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { chatSettings, dailyDigestLog, submissions } from '../../db/schema'
import { secondsSinceMidnight } from './parser'
import type { WordleResult } from './types'

export class DatabaseNotConfiguredError extends Error {
    constructor() {
        super('DATABASE_URL is not configured. Wordle features are disabled.')
    }
}

export class DuplicateSubmissionError extends Error {
    constructor() {
        super('Submission already exists for this player and puzzle.')
    }
}

export async function saveSubmission(channelId: string, result: WordleResult): Promise<void> {
    const client = ensureDb()
    try {
        await client.transaction(async (tx) => {
            await tx
                .insert(chatSettings)
                .values({ channelId })
                .onConflictDoNothing({ target: chatSettings.channelId })

            await tx.insert(submissions).values({
                channelId,
                playerId: result.playerId,
                wordleDay: result.wordleDay,
                guesses: result.guesses,
                hardMode: result.hardMode,
                grid: result.grid,
                solvedAt: result.submittedAt,
            })
        })
    } catch (error: unknown) {
        if (isUniqueViolation(error)) {
            throw new DuplicateSubmissionError()
        }
        throw error
    }
}

export async function getChannelSubmissions(channelId: string): Promise<WordleResult[]> {
    const client = ensureDb()
    const rows = await client
        .select()
        .from(submissions)
        .where(eq(submissions.channelId, channelId))
        .orderBy(submissions.wordleDay)

    return rows.map((row) => ({
        wordleDay: row.wordleDay,
        guesses: row.guesses,
        hardMode: row.hardMode,
        grid: row.grid,
        playerId: row.playerId,
        secondsSinceMidnight: row.solvedAt ? secondsSinceMidnight(new Date(row.solvedAt)) : 0,
        submittedAt: row.solvedAt ? new Date(row.solvedAt) : new Date(row.createdAt ?? Date.now()),
    }))
}

export async function getActiveChannels(): Promise<string[]> {
    const client = ensureDb()
    const rows = await client.selectDistinct({ channelId: submissions.channelId }).from(submissions)
    return rows.map((row) => row.channelId)
}

export async function markPodiumSent(channelId: string, wordleDay: number): Promise<boolean> {
    const client = ensureDb()
    const inserted = await client
        .insert(dailyDigestLog)
        .values({ channelId, wordleDay })
        .onConflictDoNothing({ target: [dailyDigestLog.channelId, dailyDigestLog.wordleDay] })
        .returning({ channelId: dailyDigestLog.channelId })

    return inserted.length > 0
}

export async function hasPodiumBeenSent(channelId: string, wordleDay: number): Promise<boolean> {
    const client = ensureDb()
    const rows = await client
        .select()
        .from(dailyDigestLog)
        .where(and(eq(dailyDigestLog.channelId, channelId), eq(dailyDigestLog.wordleDay, wordleDay)))
        .limit(1)
    return rows.length > 0
}

function ensureDb() {
    if (!db) {
        throw new DatabaseNotConfiguredError()
    }
    return db
}

function isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
        return false
    }
    const maybeError = error as { code?: string }
    return maybeError.code === '23505'
}

export type ChatSettingsRecord = {
    earlyPodium: boolean
    earlyPodiumThreshold: number
    notifyLeaderboard: boolean
    notifyTiming: boolean
    digestTime: string
    timezone: string
}

export const DEFAULT_CHAT_SETTINGS: ChatSettingsRecord = {
    earlyPodium: true,
    earlyPodiumThreshold: 5,
    notifyLeaderboard: true,
    notifyTiming: true,
    digestTime: '19:00',
    timezone: 'UTC',
}

type SettingsRow = typeof chatSettings.$inferSelect

export async function getChatSettings(channelId: string): Promise<ChatSettingsRecord> {
    const client = ensureDb()

    const existing = await client
        .select()
        .from(chatSettings)
        .where(eq(chatSettings.channelId, channelId))
        .limit(1)

    if (existing.length === 0) {
        await client.insert(chatSettings).values({ channelId }).onConflictDoNothing({ target: chatSettings.channelId })
        return { ...DEFAULT_CHAT_SETTINGS }
    }

    return normalizeSettings(existing[0])
}

export async function updateChatSettings(
    channelId: string,
    patch: Partial<ChatSettingsRecord>,
): Promise<ChatSettingsRecord> {
    const client = ensureDb()

    await client
        .insert(chatSettings)
        .values({ channelId })
        .onConflictDoNothing({ target: chatSettings.channelId })

    const updateValues: Partial<SettingsRow> = {}

    if (patch.earlyPodium !== undefined) updateValues.earlyPodium = patch.earlyPodium
    if (patch.earlyPodiumThreshold !== undefined) updateValues.earlyPodiumThreshold = patch.earlyPodiumThreshold
    if (patch.notifyLeaderboard !== undefined) updateValues.notifyLeaderboard = patch.notifyLeaderboard
    if (patch.notifyTiming !== undefined) updateValues.notifyTiming = patch.notifyTiming
    if (patch.digestTime !== undefined) updateValues.digestTime = patch.digestTime
    if (patch.timezone !== undefined) updateValues.timezone = patch.timezone

    if (Object.keys(updateValues).length > 0) {
        await client.update(chatSettings).set(updateValues).where(eq(chatSettings.channelId, channelId))
    }

    return getChatSettings(channelId)
}

function normalizeSettings(row: SettingsRow): ChatSettingsRecord {
    return {
        earlyPodium: row.earlyPodium ?? DEFAULT_CHAT_SETTINGS.earlyPodium,
        earlyPodiumThreshold: row.earlyPodiumThreshold ?? DEFAULT_CHAT_SETTINGS.earlyPodiumThreshold,
        notifyLeaderboard: row.notifyLeaderboard ?? DEFAULT_CHAT_SETTINGS.notifyLeaderboard,
        notifyTiming: row.notifyTiming ?? DEFAULT_CHAT_SETTINGS.notifyTiming,
        digestTime: row.digestTime ?? DEFAULT_CHAT_SETTINGS.digestTime,
        timezone: row.timezone ?? DEFAULT_CHAT_SETTINGS.timezone,
    }
}
