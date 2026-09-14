/**
 * The seam between the inbound message path and the agent.
 *
 * A leaf file: it imports nothing, and that is its whole purpose. `MessageProjector` sits
 * early in the module graph and is on the path of every received message; importing the
 * gateway *class* from there pulled the agent — and through it `AuthService` — into the
 * require graph ahead of the modules that own them. This codebase already has a
 * pre-existing `events.gateway ↔ auth.service` cycle that tolerates the current load order,
 * and reordering it made `AuthService` resolve as `undefined` at injection time. The
 * symptom was a DI failure in EventsGateway, several modules away from anything to do with
 * the agent.
 *
 * So the projector depends on a token and a type, never on a class. The binding is made in
 * `AgentModule` with `useExisting`, following the same rule the plugin ports document: an
 * alias rather than a factory, so Nest runs the service's lifecycle hooks once.
 */

export interface AgentChannelPort {
  /**
   * Hand one inbound engine message to the agent.
   *
   * Never throws: the caller dispatches it fire-and-forget on the path of every received
   * message, and a broken agent must not cost the inbox a message.
   */
  handleInbound(sessionId: string, raw: unknown): Promise<{ replied: boolean; text: string | null }>;
}

export const AGENT_CHANNEL_PORT = Symbol('AGENT_CHANNEL_PORT');
