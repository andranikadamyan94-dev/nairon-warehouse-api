import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

/**
 * Armenian validation messages.
 *
 * class-validator's defaults are English ("amount must be a positive number")
 * and they reach the user directly — forms show `response.data.message`. Rather
 * than adding a message to every rule on every DTO, this translates by
 * constraint name in one place, so every existing and future DTO is covered.
 *
 * Field names are mapped to Armenian labels below. The dictionary is keyed on
 * the property name rather than the DTO, because the platform reuses the same
 * names everywhere (`amount`, `quantity`, `entityId`), so one entry covers
 * every DTO that has that field. Anything unmapped falls back to the raw name,
 * which still identifies the input.
 */

/** Property name → the label the UI shows for it. */
const FIELD_LABELS: Record<string, string> = {
  // Common
  name: 'Անվանում', title: 'Վերնագիր', description: 'Նկարագրություն',
  notes: 'Նշումներ', note: 'Նշում', text: 'Տեքստ', body: 'Բովանդակություն',
  type: 'Տեսակ', status: 'Կարգավիճակ', reason: 'Պատճառ', color: 'Գույն',
  label: 'Պիտակ', level: 'Մակարդակ', order: 'Հերթականություն',
  priority: 'Առաջնահերթություն', url: 'Հասցե', file: 'Ֆայլ',
  search: 'Որոնում', page: 'Էջ', limit: 'Սահման', required: 'Պարտադիր',

  // People
  email: 'Էլ. հասցե', password: 'Գաղտնաբառ', firstName: 'Անուն',
  lastName: 'Ազգանուն', middleName: 'Հայրանուն', phone: 'Հեռախոս',
  phoneNumber: 'Հեռախոսահամար', address: 'Հասցե', salary: 'Աշխատավարձ',
  joinDate: 'Աշխատանքի սկիզբ', userId: 'Աշխատակից', roleId: 'Դեր',
  roleIds: 'Դերեր', departmentId: 'Բաժին', entityId: 'Կազմակերպություն',

  // Money
  amount: 'Գումար', unitPrice: 'Գին/հատ', initialAmount: 'Սկզբնական գումար',
  recurringAmount: 'Պարբերական գումար', transactionType: 'Վճարման ձև',
  natureId: 'Տեսակ', categoryId: 'Կատեգորիա', bankName: 'Բանկ',
  bankAccount: 'Հաշվեհամար', paymentDay: 'Վճարման օր',
  rejectionReason: 'Մերժման պատճառ',

  // Advances
  counterpartyType: 'Ստացողի տեսակ', counterpartyId: 'Ստացող',
  counterpartyName: 'Ստացողի անվանում', recoveryPerRun: 'Մարում մեկ հաշվարկից',
  maxDeductionPct: 'Առավելագույն պահում (%)', sourceRef: 'Աղբյուր',
  direction: 'Ուղղություն',

  // Warehouse
  quantity: 'Քանակ', minQuantity: 'Նվազագույն քանակ', itemId: 'Ռեսուրս',
  items: 'Ապրանքներ', assetId: 'Ակտիվ', supplierId: 'Մատակարար',
  prepaymentAmount: 'Կանխավճար', resources: 'Ռեսուրսներ', code: 'Կոդ',
  serialNumber: 'Սերիական համար', unit: 'Չափման միավոր',
  orderItemId: 'Պատվերի տող', lines: 'Տողեր',

  // Dates
  date: 'Ամսաթիվ', startDate: 'Սկիզբ', endDate: 'Ավարտ', dueDate: 'Վերջնաժամկետ',
  dateFrom: 'Սկսած', dateTo: 'Մինչև', startTime: 'Սկսելու ժամ',

  // CRM / tasks
  projectId: 'Նախագիծ', taskId: 'Առաջադրանք', statusId: 'Կարգավիճակ',
  sprintId: 'Սպրինտ', parentTaskId: 'Հիմնական առաջադրանք', parentId: 'Ծնող',
  responsibleIds: 'Պատասխանատուներ', fields: 'Դաշտեր', options: 'Տարբերակներ',
};

/**
 * "items.0.quantity" → "Ապրանքներ #1 → Քանակ". Array indices attach to the
 * field they belong to rather than reading as a separate level.
 */
function labelFor(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('.')) {
    if (/^\d+$/.test(segment) && parts.length) {
      parts[parts.length - 1] += ` #${Number(segment) + 1}`;
    } else {
      parts.push(FIELD_LABELS[segment] ?? segment);
    }
  }
  return parts.join(' → ');
}

const TEMPLATES: Record<string, (field: string, limit?: string) => string> = {
  isNotEmpty: (f) => `«${f}» դաշտը պարտադիր է`,
  isDefined: (f) => `«${f}» դաշտը պարտադիր է`,
  isString: (f) => `«${f}» դաշտը պետք է լինի տեքստ`,
  isInt: (f) => `«${f}» դաշտը պետք է լինի ամբողջ թիվ`,
  isNumber: (f) => `«${f}» դաշտը պետք է լինի թիվ`,
  isPositive: (f) => `«${f}» դաշտը պետք է լինի դրական թիվ`,
  isBoolean: (f) => `«${f}» դաշտը պետք է լինի այո/ոչ արժեք`,
  isArray: (f) => `«${f}» դաշտը պետք է լինի ցուցակ`,
  arrayNotEmpty: (f) => `«${f}» ցուցակը չի կարող դատարկ լինել`,
  isEnum: (f) => `«${f}» դաշտի արժեքն ընդունելի չէ`,
  isEmail: (f) => `«${f}» դաշտը պետք է լինի վավեր էլ. հասցե`,
  isDateString: (f) => `«${f}» դաշտը պետք է լինի վավեր ամսաթիվ`,
  isDate: (f) => `«${f}» դաշտը պետք է լինի վավեր ամսաթիվ`,
  min: (f, l) => (l ? `«${f}» դաշտը չի կարող փոքր լինել ${l}-ից` : `«${f}» դաշտի արժեքը շատ փոքր է`),
  max: (f, l) => (l ? `«${f}» դաշտը չի կարող մեծ լինել ${l}-ից` : `«${f}» դաշտի արժեքը շատ մեծ է`),
  minLength: (f, l) => (l ? `«${f}» դաշտը պետք է պարունակի առնվազն ${l} նիշ` : `«${f}» դաշտը շատ կարճ է`),
  maxLength: (f, l) => (l ? `«${f}» դաշտը չի կարող գերազանցել ${l} նիշը` : `«${f}» դաշտը շատ երկար է`),
  whitelistValidation: (f) => `«${f}» դաշտը թույլատրված չէ`,
};

/** The bound out of "must not be less than 5" — best effort, omitted if absent. */
function limitFrom(message: string): string | undefined {
  return message.match(/-?\d+(\.\d+)?/)?.[0];
}

function translate(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    for (const [rule, english] of Object.entries(error.constraints ?? {})) {
      const label = labelFor(field);
      const template = TEMPLATES[rule];
      out.push(
        template
          ? template(label, limitFrom(String(english)))
          : `«${label}» դաշտի արժեքը սխալ է`,
      );
    }
    // Arrays and nested objects report through children.
    if (error.children?.length) out.push(...translate(error.children, field));
  }
  return out;
}

/**
 * Drop-in replacement for the ValidationPipe every main.ts registers. Keeps the
 * same options; only the message language changes.
 */
export function armenianValidationPipe(options: Record<string, any> = {}) {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    ...options,
    exceptionFactory: (errors: ValidationError[]) => {
      const messages = translate(errors);
      return new BadRequestException(
        messages.length ? messages : ['Հարցման տվյալները սխալ են'],
      );
    },
  });
}
