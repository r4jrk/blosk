import { DeliveryState, type ThreadPage } from '../src/domain/comment';
import { UpstreamIndeterminate, UpstreamRejected } from '../src/domain/errors';
import { encodeCommentRef } from '../src/domain/envelope.codec';
import {
  connectedAccountId,
  localReplyId,
  Platform,
  publicationId,
  TenantScope,
  workspaceId,
  type LocalReplyId,
  type PublicationId,
} from '../src/domain/ids';
import { ReplyService } from '../src/application/reply.service';
import type {
  CommentProvider,
  PlatformCapabilities,
  PlatformProviderRegistry,
  PostReplyInput,
  PostedReply,
} from '../src/application/ports/comment-provider.port';
import type {
  CommentRepository,
  CreatePendingReplyInput,
  CreatePendingReplyResult,
  PublicationRecord,
  ReplyRecord,
} from '../src/application/ports/comment-repository.port';

/**
 * The write path — ADR-006's ordering and ADR-015's idempotency lifecycle.
 *
 * Everything here is exercised through hand-built fakes rather than a Nest testing module, which
 * is only possible because the application layer imports no framework (ADR-001). That property is
 * worth more than the tests themselves.
 */

const SCOPE = TenantScope.of(workspaceId('11111111-1111-4111-8111-111111111111'));
const PUBLICATION = publicationId('22222222-2222-4222-8222-222222222222');
const ACCOUNT = connectedAccountId('33333333-3333-4333-8333-333333333333');

const PUBLICATION_RECORD: PublicationRecord = {
  id: PUBLICATION,
  platform: Platform.LinkedIn,
  platformPostId: 'post-1',
  connectedAccountId: ACCOUNT,
  isPublished: true,
  credential: { connectedAccountId: ACCOUNT, accessToken: 'token', platformUserId: 'own-user' },
};

const SHALLOW: PlatformCapabilities = {
  maxThreadDepth: 1,
  maxReplyLength: 100,
  onDepthExceeded: 'collapse',
  mentionFormat: { kind: 'at-handle' },
  paginationDirection: 'newest-first',
};

class FakeRepository implements CommentRepository {
  readonly rows = new Map<LocalReplyId, ReplyRecord>();
  private readonly keys = new Map<string, LocalReplyId>();
  private sequence = 0;

  async findPublication(): Promise<PublicationRecord | null> {
    return PUBLICATION_RECORD;
  }

  async findReply(_scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async createPendingReply(
    _scope: TenantScope,
    input: CreatePendingReplyInput,
  ): Promise<CreatePendingReplyResult> {
    const key = input.idempotencyKey === null ? null : `${input.connectedAccountId}:${input.idempotencyKey}`;
    const held = key === null ? undefined : this.keys.get(key);
    if (held !== undefined) {
      return { kind: 'duplicate', existing: this.rows.get(held) as ReplyRecord };
    }

    this.sequence += 1;
    const id = localReplyId(`00000000-0000-4000-8000-00000000000${this.sequence}`);
    const reply: ReplyRecord = {
      id,
      publicationId: input.publicationId as PublicationId,
      connectedAccountId: input.connectedAccountId,
      deliveryState: DeliveryState.Pending,
      platformCommentId: null,
      parentPlatformCommentId: input.parent.platformCommentId,
      rootPlatformCommentId: input.parent.rootPlatformCommentId ?? input.parent.platformCommentId,
      body: input.body,
      depth: input.depth,
      threadCollapsed: input.threadCollapsed,
      failureCode: null,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    this.rows.set(id, reply);
    if (key !== null) this.keys.set(key, id);
    return { kind: 'created', reply };
  }

  async markReplySent(
    _scope: TenantScope,
    id: LocalReplyId,
    platformCommentId: string,
  ): Promise<ReplyRecord> {
    return this.patch(id, { deliveryState: DeliveryState.Sent, platformCommentId });
  }

  async markReplyFailed(
    _scope: TenantScope,
    id: LocalReplyId,
    failureCode: string,
  ): Promise<ReplyRecord> {
    // ADR-015: the key is released in the same step that records the failure.
    for (const [key, held] of this.keys) if (held === id) this.keys.delete(key);
    return this.patch(id, { deliveryState: DeliveryState.Failed, failureCode });
  }

  async markReplyUnknown(_scope: TenantScope, id: LocalReplyId): Promise<ReplyRecord> {
    // Deliberately keeps the key.
    return this.patch(id, { deliveryState: DeliveryState.Unknown });
  }

  private patch(id: LocalReplyId, changes: Partial<ReplyRecord>): ReplyRecord {
    const updated = { ...(this.rows.get(id) as ReplyRecord), ...changes };
    this.rows.set(id, updated);
    return updated;
  }
}

class FakeProvider implements CommentProvider {
  readonly platform = Platform.LinkedIn;
  readonly calls: PostReplyInput[] = [];

  constructor(
    readonly capabilities: PlatformCapabilities,
    private readonly outcome: (input: PostReplyInput) => Promise<PostedReply>,
  ) {}

  async fetchThreadPage(): Promise<ThreadPage> {
    throw new Error('not used');
  }

  async postReply(input: PostReplyInput): Promise<PostedReply> {
    this.calls.push(input);
    return this.outcome(input);
  }
}

const registryOf = (provider: CommentProvider): PlatformProviderRegistry => ({
  resolve: () => provider,
});

const posted = async (): Promise<PostedReply> => ({
  platformCommentId: 'new-comment',
  platformCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
});

const parentRef = (options: {
  id: string;
  depth: number;
  handle?: string;
  root?: string;
}): string =>
  encodeCommentRef({
    kind: 'platform',
    publicationId: PUBLICATION,
    platformCommentId: options.id,
    depth: options.depth,
    authorHandle: options.handle ?? null,
    rootPlatformCommentId: options.root ?? null,
  });

const setup = (
  capabilities: PlatformCapabilities = SHALLOW,
  outcome: (input: PostReplyInput) => Promise<PostedReply> = posted,
) => {
  const repository = new FakeRepository();
  const provider = new FakeProvider(capabilities, outcome);
  return { repository, provider, service: new ReplyService(repository, registryOf(provider)) };
};

describe('replying to a root comment', () => {
  it('posts under the requested parent and commits the record before calling the platform', async () => {
    const repository = new FakeRepository();
    let stateAtCallTime: string | undefined;
    const provider = new FakeProvider(SHALLOW, async () => {
      // ADR-006: a crash here must not lose the record of a comment published under the
      // customer's name, so the row is already durable — and PENDING — by this point.
      stateAtCallTime = [...repository.rows.values()][0]?.deliveryState;
      return posted();
    });
    const service = new ReplyService(repository, registryOf(provider));

    const outcome = await service.postReply(SCOPE, {
      publicationId: PUBLICATION,
      parentCommentId: parentRef({ id: 'c1', depth: 0 }),
      body: 'thanks!',
      idempotencyKey: null,
    });

    expect(stateAtCallTime).toBe(DeliveryState.Pending);
    expect(outcome.status).toBe('created');
    expect(outcome.reply.deliveryState).toBe(DeliveryState.Sent);
    expect(provider.calls[0]?.parentPlatformCommentId).toBe('c1');
    expect(provider.calls[0]?.body).toBe('thanks!');
  });
});

describe('replying to a reply on a platform that has only one level (ADR-009)', () => {
  it('collapses onto the root, prefixes a mention, and discloses both', async () => {
    const { service, provider } = setup();

    const outcome = await service.postReply(SCOPE, {
      publicationId: PUBLICATION,
      parentCommentId: parentRef({ id: 'c1a', depth: 1, handle: 'alice', root: 'c1' }),
      body: 'agreed',
      idempotencyKey: null,
    });

    expect(provider.calls[0]?.parentPlatformCommentId).toBe('c1');
    expect(provider.calls[0]?.body).toBe('@alice agreed');
    expect(outcome.reply.threadCollapsed).toBe(true);
    expect(outcome.reply.depth).toBe(1);
  });

  it('omits the mention where the platform exposes no handle, but still discloses the collapse', async () => {
    const { service, provider } = setup({ ...SHALLOW, mentionFormat: { kind: 'none' } });

    const outcome = await service.postReply(SCOPE, {
      publicationId: PUBLICATION,
      parentCommentId: parentRef({ id: 'c1a', depth: 1, handle: 'alice', root: 'c1' }),
      body: 'agreed',
      idempotencyKey: null,
    });

    expect(provider.calls[0]?.body).toBe('agreed');
    expect(outcome.reply.threadCollapsed).toBe(true);
  });

  it('rejects instead, where that is the platform’s declared policy', async () => {
    const { service } = setup({ ...SHALLOW, onDepthExceeded: 'reject' });

    await expect(
      service.postReply(SCOPE, {
        publicationId: PUBLICATION,
        parentCommentId: parentRef({ id: 'c1a', depth: 1, root: 'c1' }),
        body: 'agreed',
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_DEPTH_EXCEEDED', kind: 'unprocessable' });
  });

  // The mention is prepended by us and counts against the platform's limit. Checking before
  // rendering would commit a PENDING row and then be rejected upstream.
  it('counts the mention against the length limit', async () => {
    const { service, provider } = setup({ ...SHALLOW, maxReplyLength: 10 });

    await expect(
      service.postReply(SCOPE, {
        publicationId: PUBLICATION,
        parentCommentId: parentRef({ id: 'c1a', depth: 1, handle: 'alice', root: 'c1' }),
        body: 'agreed',
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({
      code: 'REPLY_TOO_LONG',
      details: { limit: 10, length: 13, mentionPrefixed: true },
    });
    expect(provider.calls).toHaveLength(0);
  });
});

describe('idempotency lifecycle (ADR-015)', () => {
  const reply = (service: ReplyService, key: string) =>
    service.postReply(SCOPE, {
      publicationId: PUBLICATION,
      parentCommentId: parentRef({ id: 'c1', depth: 0 }),
      body: 'thanks!',
      idempotencyKey: key,
    });

  it('replays a delivered reply as 200-shaped, without posting twice', async () => {
    const { service, provider } = setup();
    await reply(service, 'key-1');
    const replayed = await reply(service, 'key-1');

    expect(replayed.status).toBe('replayed');
    expect(provider.calls).toHaveLength(1);
  });

  it('reports a concurrent duplicate as in-flight rather than guessing', async () => {
    const { repository, service, provider } = setup();
    // Stall the first attempt inside the platform call so the row is PENDING when the second
    // arrives — the real race this state exists for.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stalling = new ReplyService(
      repository,
      registryOf(new FakeProvider(SHALLOW, async () => {
        await gate;
        return posted();
      })),
    );

    const first = reply(stalling, 'key-2');
    const second = await reply(service, 'key-2');
    release();
    await first;

    expect(second.status).toBe('in-flight');
    expect(provider.calls).toHaveLength(0);
  });

  it('releases the key on a determinate failure, so a correct client retry is not refused', async () => {
    const { repository, service } = setup(SHALLOW, async () => {
      throw new UpstreamRejected('comments are closed', 409);
    });

    await expect(reply(service, 'key-3')).rejects.toBeInstanceOf(UpstreamRejected);
    const failed = [...repository.rows.values()][0];
    expect(failed?.deliveryState).toBe(DeliveryState.Failed);
    expect(failed?.failureCode).toBe('UPSTREAM_REJECTED');

    // The failed row is retained for audit; it simply stops being an obstacle.
    const retry = new ReplyService(repository, registryOf(new FakeProvider(SHALLOW, posted)));
    const outcome = await reply(retry, 'key-3');
    expect(outcome.status).toBe('created');
    expect(repository.rows.size).toBe(2);
  });

  it('keeps the key when the outcome is unknown, because a retry could duplicate a public comment', async () => {
    const { repository, service, provider } = setup(SHALLOW, async () => {
      throw new UpstreamIndeterminate();
    });

    const outcome = await reply(service, 'key-4');
    expect(outcome.status).toBe('indeterminate');
    expect(outcome.reply.deliveryState).toBe(DeliveryState.Unknown);
    expect(provider.calls).toHaveLength(1);

    const replayed = await reply(service, 'key-4');
    expect(replayed.status).toBe('indeterminate');
    expect(repository.rows.size).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('replying to one of our own replies', () => {
  it('refuses while it has no platform identity, rather than posting an orphan', async () => {
    const { repository, service } = setup(SHALLOW, async () => {
      throw new UpstreamIndeterminate();
    });
    const pending = await service.postReply(SCOPE, {
      publicationId: PUBLICATION,
      parentCommentId: parentRef({ id: 'c1', depth: 0 }),
      body: 'first',
      idempotencyKey: null,
    });

    const localRef = encodeCommentRef({
      kind: 'local',
      publicationId: PUBLICATION,
      localReplyId: pending.reply.id,
    });

    await expect(
      new ReplyService(repository, registryOf(new FakeProvider(SHALLOW, posted))).postReply(SCOPE, {
        publicationId: PUBLICATION,
        parentCommentId: localRef,
        body: 'second',
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ code: 'PARENT_NOT_DELIVERED' });
  });
});
