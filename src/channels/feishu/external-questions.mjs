
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const refuse = () => { throw Object.assign(new Error('bad-request'), { code: 'bad-request' }); };
const plain = (value) => String(value).replace(/[\\`*_{}[\]()<>#|!]/g, (character) => String.fromCharCode(92) + character);
export function externalQuestionCard(value) {
  if (!value || !uuid.test(value.requestId ?? '') || !/^[A-F0-9]{12}$/.test(value.reference ?? '') ||
    !text(value.detail, 16000) || !['pending', 'answered', 'cancelled', 'expired', 'web-required'].includes(value.status) ||
    !Array.isArray(value.questions) || value.questions.length > 3 || JSON.stringify(value.questions).length > 16000) refuse();
  const labels = { pending: 'Human question / Human 提问', answered: 'Answered / 已回答', cancelled: 'Cancelled / 已取消', expired: 'Expired / 已过期', 'web-required': 'Check in Web / 请在 Web 核对' };
  const elements = [{ tag: 'markdown', content: plain(labels[value.status] + '\n' + value.detail) }];
  if (value.status === 'pending') {
    if (!value.questions.length) refuse();
    const fields = value.questions.flatMap((question, index) => {
      if (!text(question.id, 512) || !text(question.question, 16000) ||
        question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 100)) refuse();
      if ([question.header, question.detail].some((value) => value !== undefined && typeof value !== 'string')) refuse();
      const fields = [{ tag: 'markdown', content: plain([question.header, (index + 1) + '. ' + question.question, question.detail].filter(Boolean).join('\n')) }];
      for (const option of question.options ?? []) {
        if (option.description !== undefined && typeof option.description !== 'string') refuse();
        if (option.description) fields.push({ tag: 'markdown', content: plain(option.label + ': ' + option.description) });
      }
      if (question.options?.length) fields.push({ tag: question.multiSelect === true ? 'multi_select_static' : 'select_static',
        name: 'q' + index + '_choices', placeholder: { tag: 'plain_text', content: 'Choose / 选择' },
        options: question.options.map((option, pick) => {
          if (!text(option.label, 2000)) refuse();
          return { text: { tag: 'plain_text', content: option.label }, value: String(pick) };
        }) });
      fields.push({ tag: 'input', name: 'q' + index + '_custom', input_type: 'multiline_text', max_length: 2000,
        placeholder: { tag: 'plain_text', content: 'Or enter your answer / 或填写自己的答案' } });
      return fields;
    });
    fields.push({ tag: 'button', name: 'answer_submit', type: 'primary_filled', form_action_type: 'submit',
      text: { tag: 'plain_text', content: 'Submit answers / 提交答案' },
      behaviors: [{ type: 'callback', value: { namespace: 'botharness/question-v1', requestId: value.requestId, count: value.questions.length } }] });
    elements.push({ tag: 'form', name: 'questions', elements: fields });
  }
  return JSON.stringify({ schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: labels[value.status] + ' · ' + value.reference }, template: 'blue' }, body: { elements } });
}
export function questionActionValues(event) {
  const count = event.action.value.count;
  const form = event.action.form_value;
  if (!Number.isInteger(count) || count < 1 || count > 3 || !form || typeof form !== 'object' || Array.isArray(form) || JSON.stringify(form).length > 16000) refuse();
  const allowed = new Set(Array.from({ length: count }, (_, i) => ['q' + i + '_choices', 'q' + i + '_custom']).flat());
  if (Object.keys(form).some((key) => !allowed.has(key))) refuse();
  return Array.from({ length: count }, (_, i) => {
    const selected = form['q' + i + '_choices'];
    const values = selected === undefined || selected === null || selected === '' ? [] : Array.isArray(selected) ? selected : [selected];
    if (values.length > 100 || values.some((value) => typeof value !== 'string' || !/^(0|[1-9][0-9]?)$/.test(value)) || new Set(values).size !== values.length) refuse();
    const custom = form['q' + i + '_custom'];
    if (custom !== undefined && (typeof custom !== 'string' || custom.length > 2000)) refuse();
    return { selected: values.map(Number), ...(custom?.trim() ? { custom: custom.trim() } : {}) };
  });
}
