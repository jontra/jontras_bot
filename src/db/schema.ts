import { boolean, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const submissions = pgTable(
    'submissions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        channelId: text('channel_id').notNull(),
        playerId: text('player_id').notNull(),
        wordleDay: integer('wordle_day').notNull(),
        guesses: integer('guesses').notNull(),
        hardMode: boolean('hard_mode').notNull().default(false),
        grid: text('grid').notNull(),
        solvedAt: timestamp('solved_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
        uniqueSubmission: uniqueIndex('submissions_channel_player_puzzle_idx').on(table.channelId, table.playerId, table.wordleDay),
    }),
)

export const chatSettings = pgTable('chat_settings', {
    channelId: text('channel_id').primaryKey(),
    earlyPodium: boolean('early_podium').notNull().default(true),
    earlyPodiumThreshold: integer('early_podium_threshold').notNull().default(5),
    notifyLeaderboard: boolean('notify_leaderboard').notNull().default(true),
    notifyTiming: boolean('notify_timing').notNull().default(true),
    digestTime: text('digest_time').notNull().default('19:00'),
    timezone: text('timezone').notNull().default('UTC'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const dailyDigestLog = pgTable(
    'daily_digest_log',
    {
        channelId: text('channel_id').notNull(),
        wordleDay: integer('wordle_day').notNull(),
        sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ name: 'daily_digest_log_pk', columns: [table.channelId, table.wordleDay] }),
    }),
)

export type Submission = typeof submissions.$inferSelect
export type NewSubmission = typeof submissions.$inferInsert

export type ChatSettings = typeof chatSettings.$inferSelect
export type NewChatSettings = typeof chatSettings.$inferInsert

export type DailyDigestLog = typeof dailyDigestLog.$inferSelect
export type NewDailyDigestLog = typeof dailyDigestLog.$inferInsert
