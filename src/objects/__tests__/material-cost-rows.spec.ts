import { MaterialCostRowsService } from '../material-cost-rows';

describe('POST /objects/internal/material-cost-rows (CRM objects tree, 2026-10-13)', () => {
  it('groups net cost by named object and by OUT/IN task, in one query', async () => {
    const sql: string[] = [];
    const prisma: any = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sql.push(strings.join('?'));
        expect(values[0]).toEqual([1, 2]);
        return [
          { objectId: 1, taskId: null, outIn: false, sum: 10 },
          { objectId: null, taskId: 5, outIn: true, sum: '4.5' },
          { objectId: 2, taskId: 7, outIn: true, sum: null },
        ];
      }),
    };
    const out = await new MaterialCostRowsService(prisma).rows([1, 2, 2, -1, 'x' as any]);
    expect(out).toEqual({ rows: [{ objectId: 1, taskId: null, sum: 10 }, { objectId: null, taskId: 5, sum: 4.5 }, { objectId: 2, taskId: 7, sum: 0 }] });
    expect(sql[0]).toMatch(/GROUP BY/);
    expect(sql[0]).toMatch(/CASE WHEN "type" = 'OUT' THEN "totalCost" ELSE -"totalCost" END/);
    expect(sql[0]).toMatch(/"totalCost" IS NOT NULL/);
  });
});
