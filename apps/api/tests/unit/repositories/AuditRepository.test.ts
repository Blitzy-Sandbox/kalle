/**
 * Unit tests for AuditRepository — per R32 (immutable audit log), R35 (retention).
 */
import { AuditRepository } from '../../../src/repositories/AuditRepository';

const AUDIT_RECORD = {
  id: 'a-1',
  actorId: 'u-1',
  action: 'USER_LOGIN',
  targetType: 'user',
  targetId: 'u-1',
  metadata: { ip: '127.0.0.1' },
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  correlationId: 'corr-1',
  createdAt: new Date(),
};

function mkPrisma() {
  return {
    auditLog: {
      create: jest.fn().mockResolvedValue(AUDIT_RECORD),
      findMany: jest.fn().mockResolvedValue([AUDIT_RECORD]),
      count: jest.fn().mockResolvedValue(5),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  } as any;
}

describe('AuditRepository', () => {
  let prisma: ReturnType<typeof mkPrisma>;
  let repo: AuditRepository;

  beforeEach(() => {
    prisma = mkPrisma();
    repo = new AuditRepository(prisma);
  });

  it('create appends an audit log entry (R32: insert-only)', async () => {
    const result = await repo.create({
      actorId: 'u-1',
      action: 'USER_LOGIN' as any,
      targetType: 'user',
      targetId: 'u-1',
      metadata: { ip: '127.0.0.1' },
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      correlationId: 'corr-1',
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(result).toHaveProperty('id', 'a-1');
    expect(result).toHaveProperty('action', 'USER_LOGIN');
  });

  it('findByQuery returns paginated entries', async () => {
    const result = await repo.findByQuery({ limit: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalled();
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('hasMore');
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('findByQuery supports cursor pagination', async () => {
    prisma.auditLog.findMany.mockResolvedValue([AUDIT_RECORD]);
    const result = await repo.findByQuery({ cursor: 'a-0', limit: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'a-0' },
        skip: 1,
      }),
    );
    expect(result.hasMore).toBe(false);
  });

  it('count returns total matching entries', async () => {
    const result = await repo.count({ action: 'USER_LOGIN' as any });
    expect(prisma.auditLog.count).toHaveBeenCalled();
    expect(result).toBe(5);
  });

  it('count works without filters', async () => {
    const result = await repo.count();
    expect(result).toBe(5);
  });

  it('deleteOlderThan removes old entries (R35: 90-day retention)', async () => {
    const cutoff = new Date('2024-01-01');
    const result = await repo.deleteOlderThan(cutoff);
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { lt: cutoff } },
      }),
    );
    expect(result).toBe(3);
  });
});
