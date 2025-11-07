import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

const commands = [
    { name: 'help', description: 'Show available commands' },
    { name: 'scores', description: 'Show overall Wordle leaderboard' },
    { name: 'averages', description: 'Show average guesses leaderboard' },
    { name: 'weekly', description: 'Show weekly Wordle leaderboard' },
    { name: 'alltime', description: 'Show all-time Wordle leaderboard' },
    { name: 'podium', description: 'Show podium for a specific day' },
    { name: 'podium-weekly', description: 'Show this week’s Wordle podium' },
    { name: 'podium-alltime', description: 'Show all-time Wordle podium' },
    { name: 'today', description: 'Show today‘s Wordle number' },
    { name: 'ping', description: 'Check bot latency' },
    { name: 'config', description: 'Show or update channel configuration' },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
