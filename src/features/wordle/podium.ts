import { Buffer } from 'node:buffer'
import sharp from 'sharp'

export interface PodiumSlice {
    rank: number
    guesses: number
    players: string[]
    avatars: Array<{ data: Uint8Array; mime: string } | undefined>
}

const WIDTH = 1000
const HEIGHT = 820
const BACKGROUND_TOP = '#0f111a'
const BACKGROUND_BOTTOM = '#05060d'
const FOREGROUND = '#f7f8fc'
const SUBTEXT = '#d8dbea'

const PODIUM_CONFIG = [
    { rank: 2, width: 220, height: 180, color: '#CAD4E2', x: WIDTH / 2 - 380 },
    { rank: 1, width: 260, height: 220, color: '#F8D96A', x: WIDTH / 2 - 130 },
    { rank: 3, width: 220, height: 160, color: '#C98B5A', x: WIDTH / 2 + 160 },
] as const

const BASE_Y = 640
const COLUMN_RADIUS = 30

export async function renderPodiumImage(day: number, entries: PodiumSlice[]): Promise<Buffer> {
    const cards = new Map(entries.slice(0, 3).map((entry) => [entry.rank, entry]))
    const svg = buildSvg(day, cards)
    return sharp(Buffer.from(svg)).png().toBuffer()
}

function buildSvg(
    day: number,
    cards: Map<number, PodiumSlice>,
): string {
    const title = escapeXml(`Wordle ${day}`)
    const subtitle = 'Today’s top solvers'

    const podiumLayers = PODIUM_CONFIG.map((config) => createColumnMarkup(config, cards.get(config.rank))).join('')

    return `
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs>
        <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${BACKGROUND_TOP}"/>
            <stop offset="100%" stop-color="${BACKGROUND_BOTTOM}"/>
        </linearGradient>
        <radialGradient id="spotlight" cx="50%" cy="0%" r="70%">
            <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="dividerGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
            <stop offset="45%" stop-color="#ffffff" stop-opacity="0.18"/>
            <stop offset="55%" stop-color="#ffffff" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
    </defs>

    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGradient)"/>
    <ellipse cx="${WIDTH / 2}" cy="96" rx="360" ry="150" fill="url(#spotlight)"/>
    <path d="M120 78 H${WIDTH - 120}" stroke="url(#dividerGradient)" stroke-width="3.5" stroke-linecap="round"/>
    <text x="${WIDTH / 2}" y="110" font-size="62" font-weight="700" fill="${FOREGROUND}" text-anchor="middle">${title}</text>
    <text x="${WIDTH / 2}" y="150" font-size="24" fill="${SUBTEXT}" text-anchor="middle">${escapeXml(subtitle)}</text>

    ${podiumLayers}
</svg>
`
}

function createColumnMarkup(
    config: { rank: number; width: number; height: number; color: string; x: number },
    entry?: PodiumSlice,
): string {
    const columnHeight = config.height
    const columnWidth = config.width
    const columnX = config.x
    const columnY = BASE_Y - columnHeight

    const frontColor = withOpacity(config.color, 0.32)
    const strokeColor = lighten(config.color, 0.35)
    const crownIcon = getCrownPath(columnX + columnWidth / 2, columnY - 40)

    const hasPlayers = entry && entry.players.length > 0
    const playerLines = (entry?.players ?? []).map(maskAddress)
    const guessesLabel =
        entry?.guesses === undefined
            ? ''
            : entry.guesses === -1
              ? 'Puzzle not solved'
              : `${entry.guesses} guess${entry.guesses === 1 ? '' : 'es'}`

    const playerMarkup = playerLines
        .map(
            (line, idx) =>
                `<tspan x="${columnX + columnWidth / 2}" dy="${idx === 0 ? 0 : 20}">${escapeXml(line)}</tspan>`,
        )
        .join('')

    const avatarImage = entry?.avatars?.[0]
    const avatarId = `avatar-${config.rank}`

    const avatarMarkup = avatarImage
        ? `
        <g>
            <defs>
                <clipPath id="${avatarId}">
                    <circle cx="${columnX + columnWidth / 2}" cy="${columnY - 84}" r="58"/>
                </clipPath>
            </defs>
            <circle cx="${columnX + columnWidth / 2}" cy="${columnY - 84}" r="62" fill="${withOpacity(
                config.color,
                0.38,
            )}"/>
            <image x="${columnX + columnWidth / 2 - 74}" y="${columnY - 158}" width="148" height="148"
                href="${bufferToDataUrl(avatarImage.data, avatarImage.mime)}"
                xlink:href="${bufferToDataUrl(avatarImage.data, avatarImage.mime)}"
                clip-path="url(#${avatarId})"
                preserveAspectRatio="xMidYMid slice"/>
        </g>
    `
        : ''

    return `
    <g>
        <rect x="${columnX - 16}" y="${columnY + columnHeight - 22}" width="${columnWidth + 32}" height="32" rx="16" fill="#080910" opacity="0.45"/>
        <rect x="${columnX}" y="${columnY}" width="${columnWidth}" height="${columnHeight}" rx="${COLUMN_RADIUS}" fill="${frontColor}" stroke="${strokeColor}" stroke-width="2.6"/>
        <rect x="${columnX}" y="${columnY}" width="${columnWidth}" height="${columnHeight * 0.38}" rx="${COLUMN_RADIUS}" fill="${withOpacity(
            config.color,
            0.52,
        )}" />
        ${crownIcon}
        ${avatarMarkup}
        <text x="${columnX + columnWidth / 2}" y="${columnY + 46}" font-size="32" font-weight="700" text-anchor="middle" fill="${FOREGROUND}">
            #${config.rank}
        </text>
        ${
            guessesLabel
                ? `<text x="${columnX + columnWidth / 2}" y="${columnY + 66}" font-size="20" fill="${SUBTEXT}" text-anchor="middle">${escapeXml(
                      guessesLabel,
                  )}</text>`
                : ''
        }
        ${hasPlayers ? `<text x="${columnX + columnWidth / 2}" y="${columnY + columnHeight - 54}" font-size="18" fill="${FOREGROUND}" text-anchor="middle">${playerMarkup}</text>` : ''}
    </g>
    `
}

function maskAddress(address: string): string {
    const normalized = address.trim()
    if (normalized.length <= 10) {
        return normalized
    }
    return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`
}

function lighten(hex: string, amount: number): string {
    const { r, g, b } = hexToRgb(hex)
    const to = (channel: number) => Math.round(channel + (255 - channel) * amount)
    return rgbToHex(to(r), to(g), to(b))
}

function withOpacity(hex: string, opacity: number): string {
    const { r, g, b } = hexToRgb(hex)
    return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const normalized = hex.replace('#', '')
    const bigint = Number.parseInt(normalized, 16)
    return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255,
    }
}

function rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b]
        .map((channel) => {
            const hex = channel.toString(16)
            return hex.length === 1 ? `0${hex}` : hex
        })
        .join('')}`
}

function escapeXml(text: string): string {
    return text.replace(/[<>&'"]/g, (char) => {
        switch (char) {
            case '<':
                return '&lt;'
            case '>':
                return '&gt;'
            case '&':
                return '&amp;'
            case '"':
                return '&quot;'
            case "'":
                return '&#39;'
            default:
                return char
        }
    })
}

function getCrownPath(centerX: number, baselineY: number): string {
    const width = 90
    const height = 40
    const left = centerX - width / 2
    const right = centerX + width / 2
    const top = baselineY - height
    return `
    <path d="M${left} ${baselineY}
             L${left + 22} ${top + 14}
             L${centerX - 6} ${baselineY - height}
             L${centerX + 6} ${top + 6}
             L${right - 22} ${top + 18}
             L${right} ${baselineY}
             Z"
          fill="#ffffff" opacity="0.12"/>
    `
}

function bufferToDataUrl(buffer: Uint8Array, mime: string): string {
    const base64 = Buffer.from(buffer).toString('base64')
    return `data:${mime};base64,${base64}`
}
