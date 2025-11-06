import { makeTownsBot, type BotHandler } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import commands from './commands'
import {
    clampWordleDay,
    getAverages,
    getDayLeaderboardsMulti,
    getScores,
    getWeeklyScoresNow,
    getWordleDay,
    parseWordleResult,
    type WordleResult,
} from './features/wordle'
import { DuplicateSubmissionError, DatabaseNotConfiguredError, getChannelSubmissions, saveSubmission } from './features/wordle/storage'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

const AWARDS = ['🥇', '🥈', '🥉']

bot.onSlashCommand('help', async (handler, { channelId }) => {
    const bullets = [
        '**Available Commands**\n',
        '• `/scores` — Overall leaderboard\n',
        '• `/averages` — Average guesses leaderboard\n',
        '• `/weekly` — Weekly winners\n',
        '• `/podium [wordle-day]` — Podium for today or a specific day\n',
        '• `/today` — Show today’s Wordle number\n',
        '• `/ping` — Latency check\n',
    ].join('\n')

    await handler.sendMessage(channelId, bullets)
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

    const mentions = buildMentions(podium.flatMap((entry) => entry.playerIds))
    await handler.sendMessage(channelId, [`Wordle ${dayArg} podium:`, '', ...lines].join('\n'), { mentions })
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

    const sorted = Object.entries(leaderboard).sort((a, b) => b[1] - a[1])
    const lines = sorted.map(([playerId, value], index) => {
        const medal = AWARDS[index] ?? `${index + 1}.`
        return `${medal} ${formatMention(playerId)} — ${value.toFixed(2)} ${unit}`
    })

    const mentions = buildMentions(sorted.map(([playerId]) => playerId))
    const body = ['**' + capitalize(label) + '**', '', ...lines.map((line) => `${line}\n`)].join('\n')
    await handler.sendMessage(channelId, body, { mentions })
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

    try {
        await saveSubmission(channelId, result)
        const guessText = result.guesses === -1 ? 'X/6' : `${result.guesses}/6`
        const mention = formatMention(playerId)
        await handler.sendMessage(channelId, `Logged Wordle ${result.wordleDay} (${guessText}) for ${mention}.`, {
            mentions: buildMentions([playerId]),
        })
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
