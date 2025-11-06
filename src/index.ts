import { makeTownsBot, type BotHandler } from '@towns-protocol/bot'
import { TownsService } from '@towns-protocol/sdk'
import sharp from 'sharp'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import commands from './commands'
import {
    clampWordleDay,
    getAverages,
    getDayLeaderboardsMulti,
    getScores,
    getAverageTime,
    getPlayersPassed,
    getWeeklyScoresNow,
    getWordleDay,
    parseWordleResult,
    renderPodiumImage,
    type PodiumSlice,
    type WordleResult,
} from './features/wordle'
import {
    DEFAULT_CHAT_SETTINGS,
    DuplicateSubmissionError,
    DatabaseNotConfiguredError,
    getActiveChannels,
    getChannelSubmissions,
    getChatSettings,
    hasPodiumBeenSent,
    markPodiumSent,
    saveSubmission,
    updateChatSettings,
    type ChatSettingsRecord,
} from './features/wordle/storage'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

const AWARDS = ['🥇', '🥈', '🥉']
const streamMetadataBaseUrl =
    bot.client.config.services.find((service) => service.id === TownsService.StreamMetadata)?.url ?? null
const getUserProfileUrl = (userId: string, size = '200x200') =>
    streamMetadataBaseUrl ? `${streamMetadataBaseUrl}/user/${userId}/image?size=${size}` : null

const MS_PER_MINUTE = 60 * 1000
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE
const WORDLE_EPOCH_UTC = Date.UTC(2021, 5, 20)

const CONFIG_OPTIONS = {
    early_podium: {
        key: 'earlyPodium' as const,
        label: 'Early podium notifications',
        kind: 'boolean',
        description: 'Automatically post the podium once enough players finish.\n',
    },
    early_podium_threshold: {
        key: 'earlyPodiumThreshold' as const,
        label: 'Early podium threshold',
        kind: 'number',
        description: 'Number of unique players required before sending the early podium.\n',
    },
    notify_leaderboard: {
        key: 'notifyLeaderboard' as const,
        label: 'Leaderboard alerts',
        kind: 'boolean',
        description: 'notify players when they pass someone on the leaderboard.\n',
    },
    notify_timing: {
        key: 'notifyTiming' as const,
        label: 'Timing nudges',
        kind: 'boolean',
        description: 'Tell players when they solve much earlier or later than usual.\n',
    },
    digest_time: {
        key: 'digestTime' as const,
        label: 'Daily digest time',
        kind: 'time',
        description: 'Local time (HH:MM, 24h) to deliver the daily summary.\n',
    },
    timezone: {
        key: 'timezone' as const,
        label: 'Timezone',
        kind: 'string',
        description: 'IANA timezone identifier used for scheduling (e.g., UTC, America/New_York).\n',
    },
} satisfies Record<
    string,
    {
        key: keyof typeof DEFAULT_CHAT_SETTINGS
        label: string
        kind: 'boolean' | 'number' | 'time' | 'string'
        description: string
    }
>

const CONFIG_USAGE =
    '**Usage:** `/config show` to view settings, `/config set <option> <value>` to update.\n\n' +
    'Options: `early_podium`, `early_podium_threshold`, `notify_leaderboard`, `notify_timing`, `digest_time`, `timezone`.\n'

type ConfigOption = (typeof CONFIG_OPTIONS)[keyof typeof CONFIG_OPTIONS]
type ConfigOptionKey = keyof typeof CONFIG_OPTIONS

function isConfigOptionKey(value: string): value is ConfigOptionKey {
    return value in CONFIG_OPTIONS
}

bot.onSlashCommand('help', async (handler, { channelId }) => {
    const bullets = [
        '**Available Commands**\n',
        '• `/scores` — Overall leaderboard\n',
        '• `/averages` — Average guesses leaderboard\n',
        '• `/weekly` — Weekly winners\n',
        '• `/podium [wordle-day]` — Podium for today or a specific day\n',
        '• `/config show` — View or update channel settings\n',
        '• `/today` — Show today’s Wordle number\n',
        '• `/ping` — Latency check\n',
    ].join('\n')

    await handler.sendMessage(channelId, bullets)
})

bot.onSlashCommand('config', async (handler, { channelId, args }) => {
    try {
        if (args.length === 0 || args[0].toLowerCase() === 'show') {
            const settings = await getChatSettings(channelId)
            await handler.sendMessage(channelId, buildSettingsMessage(settings))
            return
        }

        if (args[0].toLowerCase() !== 'set') {
            await handler.sendMessage(channelId, CONFIG_USAGE)
            return
        }

        if (args.length < 3) {
            await handler.sendMessage(channelId, 'Usage: `/config set <option> <value>`')
            return
        }

        const optionKey = args[1].toLowerCase()
        if (!isConfigOptionKey(optionKey)) {
            await handler.sendMessage(channelId, `Unknown option \`${optionKey}\`.\n${CONFIG_USAGE}`)
            return
        }

        const option = CONFIG_OPTIONS[optionKey]
        const valueInput = args.slice(2).join(' ')
        const parsed = parseSettingValue(option, valueInput)
        if (!parsed.success) {
            await handler.sendMessage(channelId, parsed.error)
            return
        }

        const updated = await updateChatSettings(channelId, parsed.patch)
        await handler.sendMessage(
            channelId,
            `Updated **${option.label}** to ${formatSettingValue(option, updated[option.key])}.`,
        )
    } catch (error) {
        if (error instanceof DatabaseNotConfiguredError) {
            await handler.sendMessage(channelId, 'Wordle storage is not configured. Please set `DATABASE_URL` and redeploy the bot.')
            return
        }
        throw error
    }
})

bot.onSlashCommand('scores', async (handler, { channelId }) => {
    await respondWithLeaderboard(handler, channelId, 'scores', getScores)
})

bot.onSlashCommand('averages', async (handler, { channelId }) => {
    await respondWithLeaderboard(handler, channelId, 'averages', getAverages, 'avg guesses')
})

bot.onSlashCommand('weekly', async (handler, { channelId }) => {
    await respondWithLeaderboard(handler, channelId, 'weekly scores', getWeeklyScoresNow)
})

bot.onSlashCommand('podium', async (handler, { channelId, args }) => {
    const dayArg = args[0] ? Number.parseInt(args[0], 10) : getWordleDay()
    if (Number.isNaN(dayArg)) {
        await handler.sendMessage(channelId, 'Please provide a valid Wordle day (e.g., `/podium 1599`).')
        return
    }

    const results = await loadChannelResults(handler, channelId)
    if (!results) return

    const podium = getDayLeaderboardsMulti(results, dayArg)
    if (podium.length === 0) {
        await handler.sendMessage(channelId, `No submissions stored for Wordle ${dayArg} yet.`)
        return
    }

    const lines = podium.map((entry, index) => {
        const medal = AWARDS[index] ?? `${index + 1}.`
        const players = entry.playerIds.map(formatMention).join(', ')
        return `${medal} ${players} — ${entry.guesses}/6`
    })

    const textLines = [`Wordle ${dayArg} podium:`, '', ...lines]
    const mentions = buildMentions(podium.flatMap((entry) => entry.playerIds))

    let attachments:
        | Array<{
              type: 'chunked'
              data: Uint8Array
              filename: string
              mimetype: string
          }>
        | undefined
    try {
        const podiumSlices: PodiumSlice[] = podium.map((entry, index) => ({
            rank: index + 1,
            guesses: entry.guesses,
            players: entry.playerIds,
            avatars: [],
        }))
        attachments = [await createPodiumAttachment(dayArg, podiumSlices)]
    } catch (error) {
        console.error('[podium command] failed to render image', error)
    }

    await handler.sendMessage(channelId, textLines.join('\r\n'), { mentions, attachments })
})

bot.onSlashCommand('today', async (handler, { channelId }) => {
    await handler.sendMessage(channelId, `Today’s Wordle number is ${getWordleDay()}.`)
})

bot.onSlashCommand('ping', async (handler, { channelId, createdAt }) => {
    const latency = Date.now() - createdAt.getTime()
    await handler.sendMessage(channelId, `Pong! ${latency}ms`)
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt, userId }) => {
    const content = message ?? ''
    const wordleResult = parseWordleResult(content, userId, createdAt)
    if (wordleResult) {
        await handleWordleSubmission(handler, channelId, userId, wordleResult)
        return
    }

    if (content.includes('hello')) {
        await handler.sendMessage(channelId, 'Hello there! 👋')
        return
    }
    if (content.includes('ping')) {
        const now = new Date()
        await handler.sendMessage(channelId, `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`)
        return
    }
    if (content.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
})
const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)
app.post('/digest', async (c) => {
    try {
        const sent = await runDailyDigest()
        return c.json({ sent })
    } catch (error) {
        console.error('[digest] failed', error)
        return c.text('Digest failed', 500)
    }
})

export default app

async function respondWithLeaderboard(
    handler: BotHandler,
    channelId: string,
    label: string,
    compute: (results: WordleResult[]) => Record<string, number>,
    unit = 'pts.',
) {
    const results = await loadChannelResults(handler, channelId)
    if (!results) return

    const leaderboard = compute(results)
    if (Object.keys(leaderboard).length === 0) {
        await handler.sendMessage(channelId, `No ${label} data yet. Send a Wordle result to get started!`)
        return
    }

    const section = buildLeaderboardSection(capitalize(label), leaderboard, unit)
    if (!section) {
        await handler.sendMessage(channelId, `No ${label} data yet. Send a Wordle result to get started!`)
        return
    }

    const text = section.text.replace(/\n/g, '\r\n')
    await handler.sendMessage(channelId, text, { mentions: buildMentions(section.playerIds) })
}

async function loadChannelResults(handler: BotHandler, channelId: string) {
    try {
        return await getChannelSubmissions(channelId)
    } catch (error) {
        if (error instanceof DatabaseNotConfiguredError) {
            await handler.sendMessage(channelId, 'Wordle storage is not configured. Please set `DATABASE_URL` and redeploy the bot.')
            return null
        }
        throw error
    }
}

async function handleWordleSubmission(handler: BotHandler, channelId: string, playerId: string, result: WordleResult) {
    if (!clampWordleDay(result.wordleDay)) {
        await handler.sendMessage(channelId, 'That Wordle result looks out of date. Please double-check the puzzle number.')
        return
    }

    const previousResults = await getChannelSubmissions(channelId)
    const settings = await getChatSettings(channelId)

    try {
        await saveSubmission(channelId, result)
        const guessText = result.guesses === -1 ? 'X/6' : `${result.guesses}/6`
        const mention = formatMention(playerId)
        await handler.sendMessage(channelId, `Logged Wordle ${result.wordleDay} (${guessText}) for ${mention}.`, {
            mentions: buildMentions([playerId]),
        })

        const updatedResults = [...previousResults, result]

        await maybeSendEarlyPodium(handler, channelId, settings, updatedResults, result.wordleDay)
        await maybeNotifyTiming(handler, channelId, settings, previousResults, result)
        await maybeNotifyLeaderboards(handler, channelId, settings, previousResults, updatedResults, playerId)
    } catch (error) {
        if (error instanceof DuplicateSubmissionError) {
            await handler.sendMessage(channelId, 'You already submitted a result for this Wordle.')
            return
        }
        if (error instanceof DatabaseNotConfiguredError) {
            await handler.sendMessage(channelId, 'Wordle storage is not configured. Please set `DATABASE_URL` and redeploy the bot.')
            return
        }
        throw error
    }
}

async function runDailyDigest(reference: Date = new Date()): Promise<number> {
    const channels = await getActiveChannels()
    let sentCount = 0

    for (const channelId of channels) {
        const settings = await getChatSettings(channelId)
        const localNow = getLocalDateParts(settings.timezone, reference)
        if (!localNow) continue

        const digestTimeParts = parseTime(settings.digestTime)
        const windowOpenToday = hasReachedDigestTime(localNow, digestTimeParts)

        const todayWordleDay = getWordleDayForZone(settings.timezone, reference)
        const yesterdayWordleDay = getWordleDayForZone(settings.timezone, new Date(reference.getTime() - MS_PER_DAY))

        const targetDays = new Set<number>()
        if (windowOpenToday) {
            targetDays.add(todayWordleDay)
        }
        if (todayWordleDay > yesterdayWordleDay) {
            targetDays.add(yesterdayWordleDay)
        }

        if (targetDays.size === 0) {
            continue
        }

        const results = await getChannelSubmissions(channelId)

        for (const targetDay of targetDays) {
            if (targetDay <= 0) continue
            if (await hasPodiumBeenSent(channelId, targetDay)) continue
            if (!results.some((result) => result.wordleDay === targetDay)) {
                continue
            }

            const sections: { text: string; playerIds: string[] }[] = []
            let attachments:
                | Array<{
                      type: 'chunked'
                      data: Uint8Array
                      filename: string
                      mimetype: string
                  }>
                | undefined
            const podium = getDayLeaderboardsMulti(results, targetDay)
            if (podium.length > 0) {
                const lines = podium.map((entry, index) => {
                    const medal = AWARDS[index] ?? `${index + 1}.`
                    const players = entry.playerIds.map(formatMention).join(', ')
                    return `${medal} ${players} — ${entry.guesses}/6`
                })
                const playerIds = podium.flatMap((entry) => entry.playerIds)
                const text = ['**Wordle ' + targetDay + ' podium**', '', ...lines].join('\r\n')
                sections.push({ text, playerIds })

                try {
                    const podiumSlices: PodiumSlice[] = podium.map((entry, index) => ({
                        rank: index + 1,
                        guesses: entry.guesses,
                        players: entry.playerIds,
                        avatars: [],
                    }))
                    attachments = [await createPodiumAttachment(targetDay, podiumSlices)]
                } catch (error) {
                    console.error('[digest] failed to render podium image', error)
                }
            }

            const overallSection = buildLeaderboardSection('Overall scores', getScores(results), 'pts.')
            if (overallSection) sections.push(overallSection)

            const weeklySection = buildLeaderboardSection('Weekly wins', getWeeklyScoresNow(results), 'wins')
            if (weeklySection) sections.push(weeklySection)

            const averagesSection = buildLeaderboardSection('Average guesses', getAverages(results), 'avg guesses')
            if (averagesSection) sections.push(averagesSection)

            if (sections.length === 0) {
                continue
            }

            const message = sections.map((section) => section.text.replace(/\n/g, '\r\n')).join('\r\n\r\n')
            const mentions = buildMentions(sections.flatMap((section) => section.playerIds))
            await bot.sendMessage(channelId, message, { mentions, attachments })
            await markPodiumSent(channelId, targetDay)
            sentCount++
        }
    }

    return sentCount
}

function formatMention(playerId: string) {
    return `<@${playerId}>`
}

function capitalize(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1)
}

function buildMentions(playerIds: string[]) {
    const unique = [...new Set(playerIds)]
    return unique.map((userId) => ({
        userId,
        displayName: userId,
        mentionBehavior: { case: undefined, value: undefined },
    }))
}

function buildLeaderboardSection(title: string, leaderboard: Record<string, number>, unit: string) {
    if (Object.keys(leaderboard).length === 0) {
        return null
    }

    const sorted = Object.entries(leaderboard).sort((a, b) => b[1] - a[1])
    const lines = sorted.map(([playerId, value], index) => {
        const medal = AWARDS[index] ?? `${index + 1}.`
        return `${medal} ${formatMention(playerId)} — ${value.toFixed(2)} ${unit}\n`
    })

    const textLines = ['**' + title + '**', '', ...lines]
    const text = textLines.join('\n')
    const playerIds = sorted.map(([playerId]) => playerId)
    return { text, playerIds }
}

async function createPodiumAttachment(day: number, podium: PodiumSlice[]) {
    const uniqueIds = [...new Set(podium.flatMap((entry) => entry.players))]
    const avatarMap = await fetchProfileImages(uniqueIds)
    const podiumWithAvatars = await Promise.all(
        podium.map(async (entry) => {
            const avatars = await Promise.all(
                entry.players.map(async (playerId) => {
                    const raw = avatarMap.get(playerId)
                    if (!raw) return undefined
                    try {
                        const processed = await sharp(raw.data)
                            .resize(148, 148, { fit: 'cover' })
                            .png()
                            .toBuffer()
                        console.log(
                            `[podium-image] converted avatar ${playerId} original=${raw.mime} bytes=${raw.data.length} -> png bytes=${processed.length}`,
                        )
                        return { data: new Uint8Array(processed), mime: 'image/png' }
                    } catch (error) {
                        console.error(`[podium-image] failed to convert avatar for ${playerId}`, error)
                        return undefined
                    }
                }),
            )
            return { ...entry, avatars }
        }),
    )

    podiumWithAvatars.forEach((entry) => {
        entry.players.forEach((playerId, idx) => {
            const avatar = entry.avatars?.[idx]
            if (avatar) {
                console.log(`[podium-image] ${playerId} final avatar bytes=${avatar.data.length} mime=${avatar.mime}`)
            } else {
                console.warn(`[podium-image] ${playerId} missing avatar`)
            }
        })
    })

    const buffer = await renderPodiumImage(day, podiumWithAvatars)
    return {
        type: 'chunked' as const,
        data: new Uint8Array(buffer),
        filename: `wordle-${day}-podium.png`,
        mimetype: 'image/png',
    }
}

async function fetchProfileImages(
    userIds: string[],
    size = '220x220',
): Promise<Map<string, { data: Uint8Array; mime: string }>> {
    const result = new Map<string, { data: Uint8Array; mime: string }>()
    if (!streamMetadataBaseUrl) {
        return result
    }
    const uniqueIds = [...new Set(userIds)]
    await Promise.all(
        uniqueIds.map(async (userId) => {
            const url = getUserProfileUrl(userId, size)
            if (!url) return
            try {
                console.log(`[profile-image] fetching ${url}`)
                const response = await fetch(url, { headers: { accept: 'image/*,image/png,image/jpeg,image/webp' } })
                if (!response.ok) {
                    console.warn(`[profile-image] ${url} returned status ${response.status}`)
                    return
                }
                const arrayBuffer = await response.arrayBuffer()
                if (arrayBuffer.byteLength === 0) {
                    console.warn(`[profile-image] ${url} returned empty body`)
                    return
                }
                const mime = response.headers.get('content-type') ?? 'image/png'
                const data = new Uint8Array(arrayBuffer)
                // Some endpoints return a small text payload like "profileImage not found".
                if (mime.startsWith('text/') || looksLikeText(data)) {
                    const sample = Buffer.from(data.slice(0, 32)).toString('utf8')
                    console.warn(`[profile-image] ${url} returned text payload (${sample}), skipping`)
                    return
                }
                console.log(`[profile-image] ok mime=${mime} bytes=${data.length}`)
                result.set(userId, { data, mime })
            } catch (error) {
                console.error(`[profile-image] failed for ${userId}`, error)
            }
        }),
    )
    return result
}

function looksLikeText(data: Uint8Array): boolean {
    const sample = data.slice(0, Math.min(data.length, 64))
    let asciiCount = 0
    for (const byte of sample) {
        if (byte === 0) return false
        if (byte === 9 || byte === 10 || byte === 13) {
            asciiCount++
            continue
        }
        if (byte >= 32 && byte <= 126) {
            asciiCount++
            continue
        }
        return false
    }
    return asciiCount === sample.length
}

function buildSettingsMessage(settings: ChatSettingsRecord): string {
    const lines: string[] = ['**Channel Settings**', '']

    for (const optionKey of Object.keys(CONFIG_OPTIONS) as ConfigOptionKey[]) {
        const option = CONFIG_OPTIONS[optionKey]
        const value = settings[option.key]
        lines.push(`• \`${optionKey}\`: ${formatSettingValue(option, value)} — ${option.description}`)
    }

    lines.push('', CONFIG_USAGE)
    return lines.map((line) => `${line}\n`).join('')
}

function formatSettingValue(option: ConfigOption, value: ChatSettingsRecord[typeof option.key]): string {
    switch (option.kind) {
        case 'boolean':
            return (value as boolean) ? 'Enabled' : 'Disabled'
        case 'number':
            return String(value)
        case 'time':
            return value as string
        case 'string':
        default:
            return value as string
    }
}

function parseSettingValue(
    option: ConfigOption,
    rawValue: string,
): { success: true; patch: Partial<ChatSettingsRecord> } | { success: false; error: string } {
    const value = rawValue.trim()
    if (!value) {
        return { success: false, error: 'Please provide a value.' }
    }

    switch (option.kind) {
        case 'boolean': {
            const parsed = parseBoolean(value)
            if (parsed === undefined) {
                return {
                    success: false,
                    error: 'Expected a boolean value (use: `on`, `off`, `yes`, `no`, `true`, `false`).',
                }
            }
            return { success: true, patch: { [option.key]: parsed } as Partial<ChatSettingsRecord> }
        }
        case 'number': {
            const parsed = Number.parseInt(value, 10)
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return { success: false, error: 'Please provide a positive number.' }
            }
            return { success: true, patch: { [option.key]: parsed } as Partial<ChatSettingsRecord> }
        }
        case 'time': {
            const match = /^(\d{1,2}):(\d{2})$/.exec(value)
            if (!match) {
                return { success: false, error: 'Time must be in HH:MM (24-hour) format.' }
            }
            const hours = Number(match[1])
            const minutes = Number(match[2])
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
                return { success: false, error: 'Time must be between 00:00 and 23:59.' }
            }
            const normalized = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
            return { success: true, patch: { [option.key]: normalized } as Partial<ChatSettingsRecord> }
        }
        case 'string':
        default: {
            return { success: true, patch: { [option.key]: value } as Partial<ChatSettingsRecord> }
        }
    }
}

function parseBoolean(value: string): boolean | undefined {
    const normalized = value.toLowerCase()
    if (['y', 'yes', 'true', 'on', '1', 'enable', 'enabled'].includes(normalized)) return true
    if (['n', 'no', 'false', 'off', '0', 'disable', 'disabled'].includes(normalized)) return false
    return undefined
}

async function maybeSendEarlyPodium(
    handler: BotHandler,
    channelId: string,
    settings: ChatSettingsRecord,
    results: WordleResult[],
    wordleDay: number,
) {
    if (!settings.earlyPodium || settings.earlyPodiumThreshold <= 0) return

    const todaysResults = results.filter((entry) => entry.wordleDay === wordleDay)
    const uniquePlayers = new Set(todaysResults.map((entry) => entry.playerId))

    if (uniquePlayers.size < settings.earlyPodiumThreshold) {
        return
    }

    const podium = getDayLeaderboardsMulti(todaysResults, wordleDay)
    if (podium.length === 0) return

    const lines = podium.map((entry, index) => {
        const medal = AWARDS[index] ?? `${index + 1}.`
        const players = entry.playerIds.map(formatMention).join(', ')
        return `${medal} ${players} — ${entry.guesses}/6`
    })

    const mentions = buildMentions(podium.flatMap((entry) => entry.playerIds))
    const text = [`Early podium unlocked for Wordle ${wordleDay}!`, '', ...lines].join('\r\n')

    let attachments:
        | Array<{
              type: 'chunked'
              data: Uint8Array
              filename: string
              mimetype: string
          }>
        | undefined
    try {
        const podiumSlices: PodiumSlice[] = podium.map((entry, index) => ({
            rank: index + 1,
            guesses: entry.guesses,
            players: entry.playerIds,
            avatars: [],
        }))
        attachments = [await createPodiumAttachment(wordleDay, podiumSlices)]
    } catch (error) {
        console.error('[early podium] failed to render image', error)
    }

    await handler.sendMessage(channelId, text, { mentions, attachments })
}

async function maybeNotifyTiming(
    handler: BotHandler,
    channelId: string,
    settings: ChatSettingsRecord,
    previousResults: WordleResult[],
    result: WordleResult,
) {
    if (!settings.notifyTiming) return

    const personalHistory = previousResults.filter((entry) => entry.playerId === result.playerId)
    if (personalHistory.length === 0) return

    const { avg, std } = getAverageTime(previousResults, result.playerId)
    if (!Number.isFinite(avg) || !Number.isFinite(std) || std === 0) {
        return
    }

    const diff = result.secondsSinceMidnight - avg
    const formattedDiff = formatDuration(Math.abs(diff))

    if (diff > std) {
        await handler.sendMessage(
            channelId,
            `${formatMention(result.playerId)} running late? You're ${formattedDiff} after your average.`,
            { mentions: buildMentions([result.playerId]) },
        )
    } else if (diff < -std) {
        await handler.sendMessage(
            channelId,
            `${formatMention(result.playerId)} early bird! You're ${formattedDiff} before your average.`,
            { mentions: buildMentions([result.playerId]) },
        )
    }
}

async function maybeNotifyLeaderboards(
    handler: BotHandler,
    channelId: string,
    settings: ChatSettingsRecord,
    previousResults: WordleResult[],
    updatedResults: WordleResult[],
    playerId: string,
) {
    if (!settings.notifyLeaderboard) return

    const oldScores = getScores(previousResults)
    const newScores = getScores(updatedResults)
    const passedScores = getPlayersPassed(oldScores, newScores)[playerId] ?? []

    await announceLeaderboardPasses(handler, channelId, playerId, passedScores, 'overall score')

    const oldAverages = getAverages(previousResults)
    const newAverages = getAverages(updatedResults)
    const passedAverages = getPlayersPassed(oldAverages, newAverages)[playerId] ?? []

    await announceLeaderboardPasses(handler, channelId, playerId, passedAverages, 'average guesses')

    const localDay = getLocalDayOfWeek(settings.timezone)
    if (localDay !== 0) {
        const oldWeekly = getWeeklyScoresNow(previousResults)
        const newWeekly = getWeeklyScoresNow(updatedResults)
        const passedWeekly = getPlayersPassed(oldWeekly, newWeekly)[playerId] ?? []
        await announceLeaderboardPasses(handler, channelId, playerId, passedWeekly, 'weekly score')
    }
}

async function announceLeaderboardPasses(
    handler: BotHandler,
    channelId: string,
    playerId: string,
    passed: string[],
    category: string,
) {
    if (!passed || passed.length === 0) return

    const mentions = buildMentions([playerId, ...passed])
    const passedMentions = passed.map(formatMention).join(', ')
    await handler.sendMessage(
        channelId,
        `${formatMention(playerId)} just passed ${passedMentions} in ${category}! 🎉`,
        { mentions },
    )
}

function formatDuration(totalSeconds: number): string {
    const seconds = Math.round(totalSeconds)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)

    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
}

type LocalDateParts = {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
}

function getLocalDateParts(timeZone: string, reference: Date = new Date()): LocalDateParts | null {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })

        const parts = formatter.formatToParts(reference)
        const map: Partial<Record<string, string>> = {}
        for (const part of parts) {
            if (part.type === 'literal') continue
            map[part.type] = part.value
        }

        const year = Number(map.year)
        const month = Number(map.month)
        const day = Number(map.day)
        const hour = Number(map.hour)
        const minute = Number(map.minute)
        const second = Number(map.second)

        if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
            return null
        }

        return { year, month, day, hour, minute, second }
    } catch {
        return null
    }
}

function parseTime(time: string): { hour: number; minute: number } {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
    if (!match) {
        return { hour: 0, minute: 0 }
    }
    const hour = Math.min(23, Math.max(0, Number(match[1])))
    const minute = Math.min(59, Math.max(0, Number(match[2])))
    return { hour, minute }
}

function hasReachedDigestTime(local: LocalDateParts, digest: { hour: number; minute: number }): boolean {
    if (local.hour > digest.hour) return true
    if (local.hour === digest.hour && local.minute >= digest.minute) return true
    return false
}

function getWordleDayForZone(timeZone: string, reference: Date = new Date()): number {
    const local = getLocalDateParts(timeZone, reference)
    if (!local) {
        return getWordleDay(reference)
    }
    const currentMidnightUtc = Date.UTC(local.year, local.month - 1, local.day)
    return Math.floor((currentMidnightUtc - WORDLE_EPOCH_UTC) / MS_PER_DAY) + 1
}

function getLocalDayOfWeek(timeZone: string, reference: Date = new Date()): number {
    const local = getLocalDateParts(timeZone, reference)
    if (!local) return reference.getDay()
    const utcDate = new Date(Date.UTC(local.year, local.month - 1, local.day))
    return utcDate.getUTCDay()
}
