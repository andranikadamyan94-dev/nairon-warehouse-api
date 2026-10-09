import { ArgumentMetadata, BadRequestException } from '@nestjs/common';

import { armenianValidationPipe } from '../common/validation-messages';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

/**
 * #2514 (QA, 2026-10-09): a supplier could be saved with a blank or
 * whitespace name and with "test" as an e-mail — the DTOs only asked for
 * strings. Both routes (POST /suppliers, PATCH /suppliers/:id) now trim the
 * name and require it non-empty, and accept an e-mail only when it is one.
 * The owner wants no other character rule: «թեստ😊» stays a valid name.
 *
 * Driven through the global pipe (armenianValidationPipe) so the messages
 * checked are the ones a form shows.
 */

const pipe = armenianValidationPipe();
const bodyOf = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype });

async function outcome(metatype: any, body: Record<string, unknown>) {
  try {
    const value = await pipe.transform(body, bodyOf(metatype));
    return { status: 200 as const, value };
  } catch (e) {
    if (!(e instanceof BadRequestException)) throw e;
    const res = e.getResponse() as any;
    return { status: 400 as const, messages: (Array.isArray(res?.message) ? res.message : [res?.message]) as string[] };
  }
}

const ROUTES: [string, any][] = [
  ['POST /suppliers', CreateSupplierDto],
  ['PATCH /suppliers/:id', UpdateSupplierDto],
];

describe.each(ROUTES)('suppliers · %s validation (#2514)', (_route, dto) => {
  it.each([['""', ''], ['" "', ' ']])('name %s → 400 «Անվանում» դաշտը պարտադիր է', async (_label, name) => {
    const r = await outcome(dto, { name });
    expect(r.status).toBe(400);
    expect(r.messages).toEqual(['«Անվանում» դաշտը պարտադիր է']);
  });

  it.each([
    [' թեստ', 'թեստ'],
    [' թեստ ', 'թեստ'],
    ['թեստ ', 'թեստ'],
  ])('name %j is stored trimmed as %j', async (name, stored) => {
    const r = await outcome(dto, { name });
    expect(r.status).toBe(200);
    expect(r.value.name).toBe(stored);
  });

  it('name «թեստ😊» is allowed (no character restriction)', async () => {
    const r = await outcome(dto, { name: 'թեստ😊' });
    expect(r.status).toBe(200);
    expect(r.value.name).toBe('թեստ😊');
  });

  it.each(['test', 'abcdef'])('email %j → 400 «Էլ. հասցե» դաշտը պետք է լինի վավեր էլ. հասցե', async (email) => {
    const r = await outcome(dto, { name: 'Մատակարար', email });
    expect(r.status).toBe(400);
    expect(r.messages).toEqual(['«Էլ. հասցե» դաշտը պետք է լինի վավեր էլ. հասցե']);
  });

  it('a valid email is kept, trimmed', async () => {
    const r = await outcome(dto, { name: 'Մատակարար', email: ' info@example.am ' });
    expect(r.status).toBe(200);
    expect(r.value.email).toBe('info@example.am');
  });

  it('an empty email is treated as absent', async () => {
    const r = await outcome(dto, { name: 'Մատակարար', email: '' });
    expect(r.status).toBe(200);
    expect(r.value.email).toBeUndefined();
  });

  it('a manager with a blank name → 400 on the nested field', async () => {
    const r = await outcome(dto, { name: 'Մատակարար', managers: [{ name: '  ', phone: '+374' }] });
    expect(r.status).toBe(400);
    expect(r.messages).toEqual(['«managers #1 → Անվանում» դաշտը պարտադիր է']);
  });

  it('a manager name is stored trimmed; other fields pass through unchanged', async () => {
    const r = await outcome(dto, {
      name: 'Մատակարար',
      phone: ' +374 ',
      managers: [{ name: ' Արամ ', phone: '+374' }],
      bankName: 'Ameria',
    });
    expect(r.status).toBe(200);
    expect(r.value.managers[0].name).toBe('Արամ');
    expect(r.value.phone).toBe(' +374 ');
    expect(r.value.bankName).toBe('Ameria');
  });
});

describe('suppliers · update keeps every field optional (#2514)', () => {
  it('a body without name or email passes (nothing to validate)', async () => {
    const r = await outcome(UpdateSupplierDto, { notes: 'փոխված' });
    expect(r.status).toBe(200);
    expect(r.value.notes).toBe('փոխված');
  });

  it('create still requires the name', async () => {
    const r = await outcome(CreateSupplierDto, { notes: 'առանց անվան' });
    expect(r.status).toBe(400);
    expect(r.messages).toEqual(['«Անվանում» դաշտը պարտադիր է']);
  });
});
