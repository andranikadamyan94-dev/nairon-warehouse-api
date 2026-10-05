import * as fs from 'fs';
import * as path from 'path';

import { FilesService } from './files.service';
import {
  isStoredName,
  requestToken,
  sendStoredFile,
  storedNameOf,
  storedPath,
} from '../common/stored-files';

/**
 * Procurement receipts: authorization, not a URL.
 *
 * Two static mounts used to answer these — `/uploads` and `/api/uploads` — and
 * both were express middleware, so neither AuthGuard nor PermissionGuard ever
 * ran. A receipt names a supplier, quantities and prices, and anyone who could
 * reach the service with the path had it.
 */

const REQUESTER = { userId: 42, authorization: 'Bearer t' };
const NAME = 'nairon-test-receipt.png';

function service(options: {
  orders?: { receiptUrl: string | null }[];
  deliveries?: { receiptUrl: string | null }[];
  attachments?: { url: string | null }[];
  itemFiles?: { url: string | null }[];
  access?: { isSuperAdmin: boolean; permissionNames: string[] };
}) {
  const prisma = {
    procurementOrder: {
      findMany: async ({ where }: any) =>
        (options.orders ?? []).filter((r) => r.receiptUrl?.endsWith(where.receiptUrl.endsWith)),
    },
    procurementDelivery: {
      findMany: async ({ where }: any) =>
        (options.deliveries ?? []).filter((r) => r.receiptUrl?.endsWith(where.receiptUrl.endsWith)),
    },
    // A purchase requisition's attachment is a stored file of its own (2026-09-20).
    purchaseRequisitionAttachment: {
      findMany: async ({ where }: any) =>
        (options.attachments ?? []).filter((r) => r.url?.endsWith(where.url.endsWith)),
    },
    // Catalog (2026-10-01): item images and documents.
    itemImage: {
      findMany: async ({ where }: any) =>
        (options.itemFiles ?? []).filter((r) => r.url?.endsWith(where.url.endsWith)),
    },
    itemDocument: { findMany: async () => [] },
    // Catalog phase C: a submission's own attachment (none in these worlds).
    catalogSubmission: { findMany: async () => [], findFirst: async () => null },
  };
  const usersPrisma = {
    getUserAccessInfo: async () =>
      options.access ?? { isSuperAdmin: false, permissionNames: [] },
  };
  return new FilesService(prisma as never, usersPrisma as never);
}

describe('a receipt name cannot leave the directory', () => {
  it.each([
    ['traversal', '../../etc/passwd'],
    ['a backslash path', '..\\..\\windows\\win.ini'],
    ['a nested path', 'sub/dir/a.pdf'],
    ['a dotfile', '.env'],
    ['a NUL byte', 'a\0.pdf'],
    ['nothing', ''],
  ])('rejects %s', (_label, name) => {
    expect(isStoredName(name)).toBe(false);
  });

  it('reads the name out of both stored forms', () => {
    // Rows written since 2026-09 store a relative path; older ones carry a host.
    expect(storedNameOf('/uploads/a.pdf')).toBe('a.pdf');
    expect(storedNameOf('http://localhost:3005/uploads/a.pdf')).toBe('a.pdf');
    expect(storedNameOf('/uploads/../secret')).toBeNull();
  });
});

describe('who may read a warehouse receipt', () => {
  const dir = path.join(process.cwd(), 'uploads');
  const file = path.join(dir, NAME);
  let dirWasMine = false;

  beforeAll(() => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      dirWasMine = true;
    }
    fs.writeFileSync(file, 'bytes');
  });
  afterAll(() => {
    fs.rmSync(file, { force: true });
    if (dirWasMine) fs.rmSync(dir, { recursive: true, force: true });
  });

  const orders = [{ receiptUrl: `/uploads/${NAME}` }];

  it('serves it to somebody who may see procurement', async () => {
    const files = service({
      orders,
      access: { isSuperAdmin: false, permissionNames: ['view_procurement'] },
    });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBe(fs.realpathSync(file));
  });

  it('serves it from a delivery receipt as well as an order receipt', async () => {
    const files = service({
      deliveries: [{ receiptUrl: `http://localhost:3005/uploads/${NAME}` }],
      access: { isSuperAdmin: false, permissionNames: ['manage_procurement'] },
    });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBe(fs.realpathSync(file));
  });

  it('refuses a signed-in person with no procurement or receiving rights', async () => {
    // view_warehouse is the CRM task panel's right; it receives nothing.
    const files = service({
      orders,
      access: { isSuperAdmin: false, permissionNames: ['view_warehouse', 'view_reservations', 'create_purchase_requisition'] },
    });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBeNull();
  });

  it.each([['manage_inventory'], ['manage_warehouse']])(
    'serves it to the people who receive the goods against it (%s, since 2026-09-20)',
    async (permission) => {
      // The Receiving page shows the receipt link to these holders; the receipt is what they check the delivery against.
      const files = service({ orders, access: { isSuperAdmin: false, permissionNames: [permission] } });
      await expect(files.upload(NAME, REQUESTER)).resolves.toBe(fs.realpathSync(file));
    },
  );

  it('serves it to a super admin', async () => {
    const files = service({ orders, access: { isSuperAdmin: true, permissionNames: [] } });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBe(fs.realpathSync(file));
  });

  it('refuses a file nothing points at any more', async () => {
    // A receipt replaced on the order is served to nobody, whatever URL was kept.
    const files = service({ access: { isSuperAdmin: true, permissionNames: [] } });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBeNull();
  });

  it('refuses a name that is only a prefix of a referenced one', async () => {
    const files = service({
      orders: [{ receiptUrl: `/uploads/${NAME}.bak` }],
      access: { isSuperAdmin: true, permissionNames: [] },
    });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBeNull();
  });

  it('serves a requisition attachment to whoever may see requisitions, and to nobody else', async () => {
    const attachments = [{ url: `/uploads/${NAME}` }];
    for (const permission of ['create_purchase_requisition', 'approve_purchase_requisition', 'view_procurement']) {
      const files = service({ attachments, access: { isSuperAdmin: false, permissionNames: [permission] } });
      await expect(files.upload(NAME, REQUESTER)).resolves.toBe(fs.realpathSync(file));
    }
    // Receiving rights open receipts, not requisitions.
    const receiver = service({ attachments, access: { isSuperAdmin: false, permissionNames: ['manage_inventory', 'manage_warehouse'] } });
    await expect(receiver.upload(NAME, REQUESTER)).resolves.toBeNull();
  });

  it('serves an item picture to any signed-in person (the catalogue is shared), and refuses one nothing references', async () => {
    const files = service({
      itemFiles: [{ url: `/uploads/${NAME}` }],
      access: { isSuperAdmin: false, permissionNames: [] },
    });
    await expect(files.upload(NAME, REQUESTER)).resolves.toBe(fs.realpathSync(file));
    const none = service({ access: { isSuperAdmin: false, permissionNames: [] } });
    await expect(none.upload(NAME, REQUESTER)).resolves.toBeNull();
  });

  it('refuses a malformed name without reading anything', async () => {
    let read = false;
    const prisma = {
      procurementOrder: {
        findMany: async () => {
          read = true;
          return [];
        },
      },
      procurementDelivery: { findMany: async () => [] },
      purchaseRequisitionAttachment: {
        findMany: async () => {
          read = true;
          return [];
        },
      },
      itemImage: {
        findMany: async () => {
          read = true;
          return [];
        },
      },
      itemDocument: { findMany: async () => [] },
    };
    const files = new FilesService(prisma as never, { getUserAccessInfo: async () => ({}) } as never);
    await expect(files.upload('../../etc/passwd', REQUESTER)).resolves.toBeNull();
    expect(read).toBe(false);
  });

  it('keeps the storage root honest', () => {
    expect(storedPath(dir, NAME)).toBe(fs.realpathSync(file));
    expect(storedPath(dir, '../package.json')).toBeNull();
  });
});

describe('how an authorized receipt is sent', () => {
  function headersOf(name: string): Record<string, string> {
    const set: Record<string, string> = {};
    sendStoredFile(
      {
        setHeader: (k: string, v: string) => {
          set[k] = v;
        },
        type: (v: string) => {
          set['Content-Type'] = v;
        },
        sendFile: () => undefined,
      } as never,
      `/tmp/${name}`,
    );
    return set;
  }

  it('renders a PDF receipt in place', () => {
    expect(headersOf('a.pdf')['Content-Type']).toBe('application/pdf');
    expect(headersOf('a.pdf')['Content-Disposition']).toBe('inline');
  });

  it('will not render an uploaded page as this origin', () => {
    const headers = headersOf('a.html');
    expect(headers['Content-Disposition']).toBe('attachment');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
  });

  it('keeps receipts out of shared caches', () => {
    expect(headersOf('a.pdf')['Cache-Control']).toBe('private, no-cache');
    expect(headersOf('a.pdf')['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('where the credential comes from', () => {
  it('takes the header, or the session cookie an <img> carries', () => {
    expect(requestToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(requestToken({ headers: { cookie: 'nairon_session=xyz' } })).toBe('xyz');
    expect(requestToken({ headers: {} })).toBeNull();
  });
});
