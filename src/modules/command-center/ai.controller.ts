import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { Message } from '../message/entities/message.entity';
import { AiService, type TranscriptTurn } from './ai/ai.service';
import { ConversationService } from './conversation.service';
import { AnalyzeConversationDto, SuggestReplyDto, TransformDraftDto, TranslateDraftDto } from './dto/ai.dto';

/** Turns handed to the model. Enough for context, bounded so a long thread cannot blow the budget. */
const TRANSCRIPT_TURNS = 40;

/**
 * The AI copilot.
 *
 * **No endpoint here sends a WhatsApp message.** Every route returns text for a human to review in
 * the composer; this controller has no message service, no engine access, and no send capability of
 * any kind, so "AI never auto-sends" is a property of the wiring rather than a promise.
 *
 * Fences: the two conversation routes resolve through `ConversationService`, which enforces the
 * calling key's `allowedSessions`. The draft routes (`rewrite`, `shorten`, `translate`) operate
 * only on text the caller supplied and read no stored resource at all — the same reasoning that
 * puts `auth-validate.controller.ts :: validate` on the fence allowlist. All of them are registered
 * with their reason in `global-route-fence-coverage.spec.ts`.
 */
@ApiTags('Command Center — AI Copilot')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly conversations: ConversationService,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
  ) {}

  @Get('status')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Which provider is answering, so the UI can label the results honestly' })
  status() {
    return this.ai.status();
  }

  @Post('conversations/:id/analyze')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Summary, intent, sentiment, language, key details and a draft reply' })
  @ApiResponse({ status: 503, description: 'No provider could answer; the inbox is unaffected' })
  async analyze(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnalyzeConversationDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    const conversation = await this.conversations.findById(id, apiKey?.allowedSessions);
    const turns = await this.transcript(conversation.sessionId, conversation.chatId);
    return this.ai.analyze(id, turns, dto.force ?? false);
  }

  @Post('conversations/:id/suggest-reply')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Draft a reply. The draft is returned, never sent.' })
  async suggestReply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuggestReplyDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    const conversation = await this.conversations.findById(id, apiKey?.allowedSessions);
    const turns = await this.transcript(conversation.sessionId, conversation.chatId);
    return this.ai.suggestReply(turns, dto.instruction);
  }

  @Post('conversations/:id/handoff-brief')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Brief an agent taking this conversation over from a colleague',
    description:
      'What the customer wants, what our side has already committed to, the tone the previous agent ' +
      'used, what is still unanswered, and a reply that continues the thread rather than restarting ' +
      'it. Not cached — a briefing is only useful if it reflects the conversation at handover.',
  })
  @ApiResponse({ status: 503, description: 'No provider could answer; the transfer itself is unaffected' })
  async handoffBrief(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    const conversation = await this.conversations.findById(id, apiKey?.allowedSessions);
    const turns = await this.transcript(conversation.sessionId, conversation.chatId);
    return this.ai.handoffBrief(turns);
  }

  @Post('rewrite')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Rewrite the agent’s own draft more professionally' })
  rewrite(@Body() dto: TransformDraftDto) {
    return this.ai.rewrite(dto.text);
  }

  @Post('shorten')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Shorten the agent’s own draft' })
  shorten(@Body() dto: TransformDraftDto) {
    return this.ai.shorten(dto.text);
  }

  @Post('translate')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Translate the agent’s own draft' })
  translate(@Body() dto: TranslateDraftDto) {
    return this.ai.translate(dto.text, dto.targetLanguage);
  }

  /**
   * The last N turns of a chat, oldest first.
   *
   * Read straight from the persisted messages table — the same rows the thread renders — with only
   * the fields the model needs. Media rows keep their type so the transcript shows that something
   * was sent rather than presenting a gap as silence.
   */
  private async transcript(sessionId: string, chatId: string): Promise<TranscriptTurn[]> {
    const rows = await this.messages.find({
      where: { sessionId, chatId: In([chatId, chatId.replace('@c.us', '@s.whatsapp.net')]) },
      order: { createdAt: 'DESC' },
      take: TRANSCRIPT_TURNS,
      select: { id: true, body: true, direction: true, type: true, createdAt: true },
    });
    return rows.reverse().map(row => ({ direction: row.direction, body: row.body ?? '', type: row.type }));
  }
}
