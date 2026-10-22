import { z } from 'zod'

export const botCapabilitiesSchema = z.object({ text: z.boolean(), attachments: z.boolean(), approvals: z.boolean(), activity: z.boolean() }).strict()
export const botFieldSchema = z.object({ key: z.string().min(1).max(80), label: z.string().max(120), kind: z.enum(['text', 'secret-reference']), required: z.boolean(), help: z.string().max(1200) }).strict()
export const botAdapterInfoSchema = z.object({ id: z.string().min(1).max(120), version: z.literal(1), name: z.string().max(100), description: z.string().max(1200), risk: z.string().max(3000), fields: z.array(botFieldSchema).max(16) }).strict()
export const botConversationSchema = z.object({ id: z.string().min(1).max(300), title: z.string().max(200), historyScope: z.enum(['since-link', 'full']), initialCursor: z.string().max(2000).nullable() }).strict()
export const botIdentitySchema = z.object({ remoteId: z.string().min(1).max(300), name: z.string().min(1).max(200), description: z.string().max(1200), nativeUrl: z.string().url().nullable(), capabilities: botCapabilitiesSchema, conversations: z.array(botConversationSchema).min(1).max(32) }).strict()
export const botConnectionSchema = z.object({ id: z.string(), adapterId: z.string(), label: z.string(), status: z.enum(['disconnected', 'connecting', 'connected', 'auth-required', 'error', 'adapter-missing']), error: z.string().nullable(), lastSyncAt: z.number().nullable(), enabled: z.boolean(), accountId: z.string().nullable(), createdAt: z.number() }).strict()
export const botViewSchema = z.object({ id: z.string(), connectionId: z.string(), provider: z.string(), identity: botIdentitySchema, unread: z.number().int().nonnegative(), lastMessageAt: z.number().nullable(), activity: z.enum(['unknown', 'idle', 'working']) }).strict()
export const botMessageSchema = z.object({ id: z.string(), botId: z.string(), conversationId: z.string(), remoteId: z.string().nullable(), requestId: z.string().nullable(), author: z.enum(['bot', 'user']), text: z.string().max(32000), notice: z.string().max(2000).nullable(), nativeUrl: z.string().url().nullable(), createdAt: z.number(), updatedAt: z.number(), delivery: z.enum(['received', 'sending', 'sent', 'failed', 'uncertain']) }).strict()
export const botsSnapshotSchema = z.object({ revision: z.number(), adapters: z.array(botAdapterInfoSchema), connections: z.array(botConnectionSchema), bots: z.array(botViewSchema) }).strict()
export const botConnectInputSchema = z.object({ adapterId: z.string().min(1).max(120), label: z.string().trim().min(1).max(100), config: z.record(z.string().max(80), z.string().max(4096)), acceptRisks: z.literal(true) }).strict()
export type BotCapabilities = z.infer<typeof botCapabilitiesSchema>
export type BotAdapterInfo = z.infer<typeof botAdapterInfoSchema>
export type BotIdentity = z.infer<typeof botIdentitySchema>
export type BotConnection = z.infer<typeof botConnectionSchema>
export type BotView = z.infer<typeof botViewSchema>
export type BotMessage = z.infer<typeof botMessageSchema>
export type BotsSnapshot = z.infer<typeof botsSnapshotSchema>
export type BotConnectInput = z.infer<typeof botConnectInputSchema>
