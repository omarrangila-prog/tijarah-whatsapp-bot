import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AgentSettings } from './entities/agent-settings.entity';
import { AgentAdminNumber } from './entities/agent-admin-number.entity';
import { AgentToolPolicy } from './entities/agent-tool-policy.entity';
import { AgentApproval } from './entities/agent-approval.entity';
import { AgentTurn } from './entities/agent-turn.entity';
import { AgentEvent } from './entities/agent-event.entity';
import { CustomerProfile } from '../command-center/entities/customer-profile.entity';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { ApprovalService } from './approval.service';
import { AgentRuntime } from './agent-runtime.service';
import { MockReasoningProvider } from './mock-reasoning.provider';
import { GeminiReasoningProvider } from './gemini-reasoning.provider';
import { OpenAiCompatibleReasoningProvider } from './openai-compatible-reasoning.provider';
import { AnthropicAiProvider } from '../command-center/ai/anthropic.provider';
import { REASONING_PROVIDERS, type ReasoningProvider } from './agent-reasoning.interface';
import { ContactMapper } from '../../integrations/whatsapp/contact-mapper';
import { PermissionGuard } from '../../integrations/whatsapp/permission-guard';
import { MediaHandler } from '../../integrations/whatsapp/media-handler';
import { SessionManager } from '../../integrations/whatsapp/session-manager';
import { WhatsAppGateway } from '../../integrations/whatsapp/whatsapp.gateway';
import { OpenWaProvider } from '../../integrations/whatsapp/openwa.provider';
import { MockWhatsAppProvider } from '../../integrations/whatsapp/mock.provider';
import { WHATSAPP_PROVIDER } from '../../integrations/whatsapp/whatsapp-provider.interface';
import { AGENT_CHANNEL_PORT } from '../../integrations/whatsapp/agent-channel.port';
import { AgentEventService } from './agent-event.service';
import { AgentController } from './agent.controller';
import { MockLedgerAdapter } from '../../integrations/ledger/mock.adapter';
import { RestLedgerAdapter } from '../../integrations/ledger/rest.adapter';
import { LEDGER_PORT } from '../../integrations/ledger/ledger.port';

/**
 * The agent channel.
 *
 * NOT `@Global`. It was, and that deadlocked container construction: a global module whose
 * providers transitively need SessionModule, while SessionModule needs this module's channel
 * port, gave Nest a loop it resolved by hanging — 57 modules reporting "dependencies
 * initialized" and then nothing. The edge now runs one way, the way this codebase already
 * runs it for the conversation recorder: SessionModule imports this module.
 *
 * Global, and importing only `AuthModule`, because of the dependency rule this codebase
 * already follows: SessionModule imports the business layer so `MessageProjector` can hold
 * an optional collaborator, which means nothing on this side may import SessionModule or
 * MessageModule back. Sending is reached through `PLUGIN_MESSAGE_PORT` resolved lazily at
 * call time; `Session` and `Message` are registered here as REPOSITORIES only — entity
 * access on the shared `data` connection, not a dependency on the modules that own them.
 *
 * `ToolRegistryService` needs no import: `AgentToolsModule` is `@Global`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [
        AgentSettings,
        AgentAdminNumber,
        AgentToolPolicy,
        AgentApproval,
        AgentTurn,
        AgentEvent,
        CustomerProfile,
        Session,
        Message,
      ],
      'data',
    ),
    AuthModule,
  ],
  controllers: [AgentController],
  providers: [
    ApprovalService,
    AgentRuntime,
    AgentEventService,
    ContactMapper,
    PermissionGuard,
    MediaHandler,
    SessionManager,
    WhatsAppGateway,
    GeminiReasoningProvider,
    OpenAiCompatibleReasoningProvider,
    MockReasoningProvider,
    OpenWaProvider,
    MockWhatsAppProvider,
    MockLedgerAdapter,
    RestLedgerAdapter,

    /**
     * Which accounting system the agent reads and writes.
     *
     * `LEDGER_REST_CONFIG` (a path to a JSON connection file) selects the client's own
     * system through the generic REST adapter. Without it the in-memory demo ledger is
     * used, so the whole invoice → send → track → settle loop is exercisable before a
     * client's system is connected — and a demo ledger can never touch real accounts.
     */
    {
      provide: LEDGER_PORT,
      inject: [RestLedgerAdapter, MockLedgerAdapter],
      useFactory: (rest: RestLedgerAdapter, mock: MockLedgerAdapter) => (rest.isConfigured() ? rest : mock),
    },

    /*
     * The model provider, constructed here rather than imported from CommandCenterModule.
     *
     * Same class, same configuration, same API key — the copilot's provider, now also able
     * to run a tool-calling turn because `reason()` was added to it. What is deliberately
     * NOT done is importing CommandCenterModule to borrow its instance: SessionModule
     * already imports CommandCenterModule, and SessionModule must be able to reach this
     * module, so that edge would close a cycle. The provider holds no state beyond a
     * lazily-created SDK client, so a second instance costs nothing.
     */
    AnthropicAiProvider,

    /**
     * The inbound seam.
     *
     * `useExisting` rather than a factory: the plugin-ports header records why — Nest runs
     * lifecycle hooks once per non-alias provider, and a factory returning the instance
     * doubles them.
     */
    { provide: AGENT_CHANNEL_PORT, useExisting: WhatsAppGateway },

    /**
     * Which transport the agent sends through.
     *
     * `AGENT_WHATSAPP_MOCK=true` swaps in the in-memory provider, which is how the demo and
     * the integration tests run without a scanned account. The choice is made once, here,
     * so no caller has to know which one is live — and a mock send is still stamped `mock`
     * on its result, so nothing downstream can mistake one for the other.
     */
    {
      provide: WHATSAPP_PROVIDER,
      inject: [OpenWaProvider, MockWhatsAppProvider],
      useFactory: (real: OpenWaProvider, mock: MockWhatsAppProvider) =>
        process.env.AGENT_WHATSAPP_MOCK === 'true' ? mock : real,
    },

    /**
     * Reasoning providers, most preferred first.
     *
     * The Anthropic provider is the one already configured for the copilot — the same key,
     * the same client, now also able to run a tool-calling turn. The rule engine sits behind
     * it and is always available, so an unconfigured or unreachable model degrades the agent
     * to something deterministic rather than taking the channel down.
     */
    {
      provide: REASONING_PROVIDERS,
      inject: [OpenAiCompatibleReasoningProvider, AnthropicAiProvider, GeminiReasoningProvider, MockReasoningProvider],
      useFactory: (
        openAiCompatible: OpenAiCompatibleReasoningProvider,
        anthropic: AnthropicAiProvider,
        gemini: GeminiReasoningProvider,
        mock: MockReasoningProvider,
      ): ReasoningProvider[] => {
        if (process.env.AGENT_REASONING_MOCK === 'true') return [mock];
        /*
         * Ordered by preference, and the runtime takes the first that is AVAILABLE — so a
         * deployment configures whichever key it has and the rest stay dormant.
         *
         * The OpenAI-compatible provider is first because it is the only one an operator has
         * to opt into: it reports itself unavailable unless AI_BASE_URL, AI_API_KEY and
         * AI_MODEL are all set, so putting it first costs nothing when it is unconfigured and
         * means a paid key takes precedence over a free tier when it is. Gemini then
         * Anthropic; the mock is last so an unreachable model degrades the channel to
         * something deterministic rather than taking it down.
         */
        return [openAiCompatible, gemini, anthropic, mock];
      },
    },
  ],
  exports: [
    LEDGER_PORT,
    AGENT_CHANNEL_PORT,
    WhatsAppGateway,
    AgentRuntime,
    ApprovalService,
    AgentEventService,
    ContactMapper,
    PermissionGuard,
    SessionManager,
    WHATSAPP_PROVIDER,
  ],
})
export class AgentModule {}
