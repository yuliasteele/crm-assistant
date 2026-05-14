require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- Contacts ---

app.get('/contacts', (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
  res.json(contacts);
});

app.post('/contacts', (req, res) => {
  const { name, email, phone, company } = req.body;
  const result = db.prepare(
    'INSERT INTO contacts (name, email, phone, company) VALUES (?, ?, ?, ?)'
  ).run(name, email, phone, company);
  res.json({ id: result.lastInsertRowid });
});

app.put('/contacts/:id', (req, res) => {
  const { name, email, phone, company } = req.body;
  db.prepare(
    'UPDATE contacts SET name=?, email=?, phone=?, company=? WHERE id=?'
  ).run(name, email, phone, company, req.params.id);
  res.json({ success: true });
});

app.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// --- Deals ---

app.get('/deals', (req, res) => {
  const deals = db.prepare(`
    SELECT deals.*, contacts.name AS contact_name
    FROM deals LEFT JOIN contacts ON deals.contact_id = contacts.id
    ORDER BY deals.created_at DESC
  `).all();
  res.json(deals);
});

app.post('/deals', (req, res) => {
  const { title, amount, status, contact_id } = req.body;
  const result = db.prepare(
    'INSERT INTO deals (title, amount, status, contact_id) VALUES (?, ?, ?, ?)'
  ).run(title, amount, status || 'new', contact_id);
  res.json({ id: result.lastInsertRowid });
});

app.put('/deals/:id', (req, res) => {
  const { title, amount, status, contact_id } = req.body;
  db.prepare(
    'UPDATE deals SET title=?, amount=?, status=?, contact_id=? WHERE id=?'
  ).run(title, amount, status, contact_id, req.params.id);
  res.json({ success: true });
});

app.delete('/deals/:id', (req, res) => {
  db.prepare('DELETE FROM deals WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// --- Tasks ---

app.get('/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT tasks.*, contacts.name AS contact_name
    FROM tasks LEFT JOIN contacts ON tasks.contact_id = contacts.id
    ORDER BY tasks.deadline ASC
  `).all();
  res.json(tasks);
});

app.post('/tasks', (req, res) => {
  const { description, deadline, status, contact_id } = req.body;
  const result = db.prepare(
    'INSERT INTO tasks (description, deadline, status, contact_id) VALUES (?, ?, ?, ?)'
  ).run(description, deadline, status || 'pending', contact_id);
  res.json({ id: result.lastInsertRowid });
});

app.put('/tasks/:id', (req, res) => {
  const { description, deadline, status, contact_id } = req.body;
  db.prepare(
    'UPDATE tasks SET description=?, deadline=?, status=?, contact_id=? WHERE id=?'
  ).run(description, deadline, status, contact_id, req.params.id);
  res.json({ success: true });
});

app.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// --- AI Assistant ---

const tools = [
  {
    type: 'function',
    function: {
      name: 'create_contact',
      description: 'Create a new contact in CRM',
      parameters: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Contact name' },
          email:   { type: 'string', description: 'Email' },
          phone:   { type: 'string', description: 'Phone number' },
          company: { type: 'string', description: 'Company' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_contact',
      description: 'Update an existing contact',
      parameters: {
        type: 'object',
        properties: {
          id:      { type: ['integer', 'string'], description: 'Contact ID' },
          name:    { type: 'string' },
          email:   { type: 'string' },
          phone:   { type: 'string' },
          company: { type: 'string' },
        },
        required: ['id', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_contact',
      description: 'Delete a contact',
      parameters: {
        type: 'object',
        properties: { id: { type: ['integer', 'string'], description: 'Contact ID' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_deal',
      description: 'Create a new deal',
      parameters: {
        type: 'object',
        properties: {
          title:      { type: 'string', description: 'Deal title' },
          amount:     { type: ['number', 'string'], description: 'Deal amount' },
          status:     { type: 'string', enum: ['new', 'negotiation', 'won', 'lost'] },
          contact_id: { type: ['integer', 'string'], description: 'ID of the linked contact' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_deal',
      description: 'Update an existing deal',
      parameters: {
        type: 'object',
        properties: {
          id:         { type: ['integer', 'string'] },
          title:      { type: 'string' },
          amount:     { type: ['number', 'string'] },
          status:     { type: 'string', enum: ['new', 'negotiation', 'won', 'lost'] },
          contact_id: { type: ['integer', 'string'] },
        },
        required: ['id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_deal',
      description: 'Delete a deal',
      parameters: {
        type: 'object',
        properties: { id: { type: ['integer', 'string'] } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Task description' },
          deadline:    { type: 'string', description: 'Deadline in ISO 8601 format' },
          status:      { type: 'string', enum: ['pending', 'done'] },
          contact_id:  { type: ['integer', 'string'], description: 'ID of the linked contact' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update an existing task',
      parameters: {
        type: 'object',
        properties: {
          id:          { type: ['integer', 'string'] },
          description: { type: 'string' },
          deadline:    { type: 'string' },
          status:      { type: 'string', enum: ['pending', 'done'] },
          contact_id:  { type: ['integer', 'string'] },
        },
        required: ['id', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Delete a task',
      parameters: {
        type: 'object',
        properties: { id: { type: ['integer', 'string'] } },
        required: ['id'],
      },
    },
  },
];

function extractContactData(message) {
  const result = {};

  const emailMatch = message.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) result.email = emailMatch[0];

  const phoneMatch = message.match(/(?:\+7|8)?[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  if (phoneMatch) result.phone = phoneMatch[0].trim();

  const companyMatch = message.match(/(?:компани[яи]|фирм[аы]|организаци[яи])\s+([^\n,]+)/i)
    || message.match(/\b(ООО|АО|ИП|ЗАО)\s+([^\n,]+)/i);
  if (companyMatch) result.company = (companyMatch[2] || companyMatch[1]).trim();

  const cyrillicWord = '[А-ЯЁ][а-яёА-ЯЁ]+';
  const nameRegex = new RegExp(`${cyrillicWord}(?:\\s+${cyrillicWord}){1,2}`, 'g');
  const stopWords = new Set(['добавь', 'контакт', 'создай', 'измени', 'удали', 'телефон', 'компания', 'компании', 'email', 'новый', 'новая']);
  const allMatches = [...message.matchAll(nameRegex)];
  const nameMatch = allMatches.find(m => {
    const words = m[0].split(/\s+/);
    return words.every(w => !stopWords.has(w.toLowerCase()));
  });
  if (nameMatch) result.name = nameMatch[0].trim();

  return result;
}

function sanitizeContactArgs(args, message) {
  const extracted = extractContactData(message);
  return {
    ...args,
    ...(extracted.name    ? { name:    extracted.name    } : {}),
    ...(extracted.email   ? { email:   extracted.email   } : {}),
    ...(extracted.phone   ? { phone:   extracted.phone   } : {}),
    ...(extracted.company ? { company: extracted.company } : {}),
  };
}

function executeTool(name, args) {
  if (args.id         != null) args.id         = Number(args.id);
  if (args.contact_id != null) args.contact_id = Number(args.contact_id);
  if (args.amount     != null) args.amount     = Number(args.amount);
  switch (name) {
    case 'create_contact':
      return { id: db.prepare('INSERT INTO contacts (name, email, phone, company) VALUES (?, ?, ?, ?)').run(args.name, args.email ?? null, args.phone ?? null, args.company ?? null).lastInsertRowid };
    case 'update_contact':
      db.prepare('UPDATE contacts SET name=?, email=?, phone=?, company=? WHERE id=?').run(args.name, args.email ?? null, args.phone ?? null, args.company ?? null, args.id);
      return { success: true };
    case 'delete_contact':
      db.prepare('DELETE FROM contacts WHERE id=?').run(args.id);
      return { success: true };
    case 'create_deal':
      return { id: db.prepare('INSERT INTO deals (title, amount, status, contact_id) VALUES (?, ?, ?, ?)').run(args.title, args.amount ?? null, args.status ?? 'new', args.contact_id ?? null).lastInsertRowid };
    case 'update_deal':
      db.prepare('UPDATE deals SET title=?, amount=?, status=?, contact_id=? WHERE id=?').run(args.title, args.amount ?? null, args.status ?? 'new', args.contact_id ?? null, args.id);
      return { success: true };
    case 'delete_deal':
      db.prepare('DELETE FROM deals WHERE id=?').run(args.id);
      return { success: true };
    case 'create_task':
      return { id: db.prepare('INSERT INTO tasks (description, deadline, status, contact_id) VALUES (?, ?, ?, ?)').run(args.description, args.deadline ?? null, args.status ?? 'pending', args.contact_id ?? null).lastInsertRowid };
    case 'update_task':
      db.prepare('UPDATE tasks SET description=?, deadline=?, status=?, contact_id=? WHERE id=?').run(args.description, args.deadline ?? null, args.status ?? 'pending', args.contact_id ?? null, args.id);
      return { success: true };
    case 'delete_task':
      db.prepare('DELETE FROM tasks WHERE id=?').run(args.id);
      return { success: true };
    default:
      return { error: 'Unknown tool' };
  }
}

app.post('/chat', async (req, res) => {
  const { message, contact_id } = req.body;

  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE contact_id IS ?
    ORDER BY created_at ASC LIMIT 50
  `).all(contact_id ?? null);

  const systemPrompt = `You are an internal CRM assistant. You have full access to the database of contacts, deals, and tasks. You can add, update, and delete any records upon user request. Always confirm exactly what you did in the database. Reply in English.
Use tools for any database changes — do not describe actions in words, execute them.
IMPORTANT: pass names, surnames, company names, and any other data to the tools EXACTLY as the user wrote them — do not modify, correct, or substitute any word.
Current CRM data:

Contacts: ${JSON.stringify(db.prepare('SELECT * FROM contacts').all())}
Deals: ${JSON.stringify(db.prepare('SELECT * FROM deals').all())}
Tasks: ${JSON.stringify(db.prepare('SELECT * FROM tasks').all())}`;

  db.prepare('INSERT INTO messages (role, content, contact_id) VALUES (?, ?, ?)').run('user', message, contact_id ?? null);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message },
  ];

  let response = await groq.chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 1024,
    tools,
    tool_choice: 'auto',
    messages,
  });

  const toolsUsed = [];

  while (response.choices[0].finish_reason === 'tool_calls') {
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    const toolResults = assistantMsg.tool_calls.map(tc => {
      let args = JSON.parse(tc.function.arguments);
      if (tc.function.name === 'create_contact' || tc.function.name === 'update_contact') {
        args = sanitizeContactArgs(args, message);
      }
      const result = executeTool(tc.function.name, args);
      toolsUsed.push(tc.function.name);
      return {
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      };
    });

    messages.push(...toolResults);

    response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 1024,
      tools,
      tool_choice: 'auto',
      messages,
    });
  }

  const reply = response.choices[0].message.content;
  db.prepare('INSERT INTO messages (role, content, contact_id) VALUES (?, ?, ?)').run('assistant', reply, contact_id ?? null);

  res.json({ reply, toolsUsed });
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

// --- Messages history ---

app.get('/messages', (req, res) => {
  const { contact_id } = req.query;
  const messages = db.prepare(`
    SELECT * FROM messages WHERE contact_id IS ?
    ORDER BY created_at ASC
  `).all(contact_id ?? null);
  res.json(messages);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
