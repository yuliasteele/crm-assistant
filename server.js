require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'crm-secret';

// --- Email ---

const mailerReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.NOTIFY_EMAIL);
const mailer = mailerReady ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

async function sendEmail(subject, html) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.NOTIFY_EMAIL,
      subject,
      html,
    });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

function emailHtml(title, body) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
    <h2 style="color:#6c63ff;margin:0 0 16px">${title}</h2>
    ${body}
    <p style="margin-top:24px;font-size:12px;color:#aaa">CRM Assistant</p>
  </div>`;
}

// Overdue tasks reminder — runs every hour, sends at most once per day
let lastOverdueEmail = 0;
function checkAndEmailOverdue() {
  if (!mailer) return;
  if (Date.now() - lastOverdueEmail < 23 * 60 * 60 * 1000) return;
  const rows = db.prepare(`
    SELECT t.*, c.name AS contact_name FROM tasks t
    LEFT JOIN contacts c ON t.contact_id = c.id
    WHERE t.status='pending' AND t.deadline < datetime('now')
    ORDER BY t.deadline ASC
  `).all();
  if (!rows.length) return;
  lastOverdueEmail = Date.now();
  const items = rows.map(t =>
    `<li style="margin-bottom:6px"><strong>${t.description}</strong>` +
    (t.contact_name ? ` &mdash; ${t.contact_name}` : '') +
    ` <span style="color:#ef4444">(due ${new Date(t.deadline).toLocaleDateString('en')})</span></li>`
  ).join('');
  sendEmail(
    `[CRM] ${rows.length} overdue task${rows.length > 1 ? 's' : ''}`,
    emailHtml('Overdue Tasks', `<p>You have <strong>${rows.length}</strong> overdue task(s):</p><ul>${items}</ul>`)
  );
}
setInterval(checkAndEmailOverdue, 60 * 60 * 1000);

// --- Auth ---

// Seed first admin from env vars if no users exist
if (db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0) {
  const hash = bcrypt.hashSync(process.env.CRM_PASSWORD || 'admin', 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    process.env.CRM_USERNAME || 'admin', hash, 'admin'
  );
  console.log(`Created admin user: ${process.env.CRM_USERNAME || 'admin'}`);
}

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, role: user.role });
});

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

app.use(requireAuth);

// --- Contacts ---

function withTags(entities, junctionTable, fkField) {
  if (!entities.length) return entities;
  const rows = db.prepare(`
    SELECT ct.${fkField}, t.id AS tag_id, t.name, t.color
    FROM ${junctionTable} ct JOIN tags t ON ct.tag_id = t.id
  `).all();
  const map = {};
  rows.forEach(r => { (map[r[fkField]] ||= []).push({ id: r.tag_id, name: r.name, color: r.color }); });
  entities.forEach(e => { e.tags = map[e.id] || []; });
  return entities;
}

app.get('/contacts', (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
  res.json(withTags(contacts, 'contact_tags', 'contact_id'));
});

function logActivity(action, entityType, entityId, entityName) {
  db.prepare('INSERT INTO activity_log (action, entity_type, entity_id, entity_name) VALUES (?, ?, ?, ?)')
    .run(action, entityType, entityId ?? null, entityName ?? null);
}

app.post('/contacts', (req, res) => {
  const { name, email, phone, company } = req.body;
  const result = db.prepare(
    'INSERT INTO contacts (name, email, phone, company) VALUES (?, ?, ?, ?)'
  ).run(name, email, phone, company);
  logActivity('created', 'contact', result.lastInsertRowid, name);
  res.json({ id: result.lastInsertRowid });
});

app.put('/contacts/:id', (req, res) => {
  const { name, email, phone, company } = req.body;
  db.prepare(
    'UPDATE contacts SET name=?, email=?, phone=?, company=? WHERE id=?'
  ).run(name, email, phone, company, req.params.id);
  logActivity('updated', 'contact', req.params.id, name);
  res.json({ success: true });
});

app.delete('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT name FROM contacts WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id);
  logActivity('deleted', 'contact', req.params.id, row?.name);
  res.json({ success: true });
});

// --- Deals ---

app.get('/deals', (req, res) => {
  const deals = db.prepare(`
    SELECT deals.*, contacts.name AS contact_name
    FROM deals LEFT JOIN contacts ON deals.contact_id = contacts.id
    ORDER BY deals.created_at DESC
  `).all();
  res.json(withTags(deals, 'deal_tags', 'deal_id'));
});

app.post('/deals', (req, res) => {
  const { title, amount, status, contact_id } = req.body;
  const result = db.prepare(
    'INSERT INTO deals (title, amount, status, contact_id) VALUES (?, ?, ?, ?)'
  ).run(title, amount, status || 'new', contact_id);
  logActivity('created', 'deal', result.lastInsertRowid, title);
  res.json({ id: result.lastInsertRowid });
});

app.put('/deals/:id', (req, res) => {
  const { title, amount, status, contact_id } = req.body;
  const old = db.prepare('SELECT status FROM deals WHERE id=?').get(req.params.id);
  db.prepare(
    'UPDATE deals SET title=?, amount=?, status=?, contact_id=? WHERE id=?'
  ).run(title, amount, status, contact_id, req.params.id);
  logActivity('updated', 'deal', req.params.id, title);
  if (old && status && old.status !== status) {
    const stage = db.prepare('SELECT label FROM pipeline_stages WHERE name=?').get(status);
    const oldStage = db.prepare('SELECT label FROM pipeline_stages WHERE name=?').get(old.status);
    sendEmail(
      `[CRM] Deal updated: ${title}`,
      emailHtml('Deal Status Changed', `
        <p><strong>${title}</strong></p>
        <p>${oldStage?.label || old.status} &rarr; <strong>${stage?.label || status}</strong></p>
        ${amount ? `<p>Amount: ${Number(amount).toLocaleString('en')} ₽</p>` : ''}
      `)
    );
  }
  res.json({ success: true });
});

app.delete('/deals/:id', (req, res) => {
  const row = db.prepare('SELECT title FROM deals WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM deals WHERE id=?').run(req.params.id);
  logActivity('deleted', 'deal', req.params.id, row?.title);
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
  logActivity('created', 'task', result.lastInsertRowid, description);
  if (deadline) {
    const contact = contact_id ? db.prepare('SELECT name FROM contacts WHERE id=?').get(contact_id) : null;
    sendEmail(
      `[CRM] New task: ${description}`,
      emailHtml('New Task Created', `
        <p><strong>${description}</strong></p>
        ${contact ? `<p>Contact: ${contact.name}</p>` : ''}
        <p>Due: <strong>${new Date(deadline).toLocaleString('en')}</strong></p>
      `)
    );
  }
  res.json({ id: result.lastInsertRowid });
});

app.put('/tasks/:id', (req, res) => {
  const { description, deadline, status, contact_id } = req.body;
  db.prepare(
    'UPDATE tasks SET description=?, deadline=?, status=?, contact_id=? WHERE id=?'
  ).run(description, deadline, status, contact_id, req.params.id);
  logActivity('updated', 'task', req.params.id, description);
  res.json({ success: true });
});

app.delete('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT description FROM tasks WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  logActivity('deleted', 'task', req.params.id, row?.description);
  res.json({ success: true });
});

// --- Notes ---

app.get('/notes', (req, res) => {
  const { contact_id, deal_id } = req.query;
  let query = 'SELECT * FROM notes WHERE 1=1';
  const params = [];
  if (contact_id) { query += ' AND contact_id = ?'; params.push(Number(contact_id)); }
  if (deal_id)    { query += ' AND deal_id = ?';    params.push(Number(deal_id)); }
  query += ' ORDER BY created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/notes', (req, res) => {
  const { content, contact_id, deal_id } = req.body;
  const result = db.prepare(
    'INSERT INTO notes (content, contact_id, deal_id) VALUES (?, ?, ?)'
  ).run(content, contact_id ?? null, deal_id ?? null);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/notes/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id=?').run(req.params.id);
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
    case 'create_contact': {
      const id = db.prepare('INSERT INTO contacts (name, email, phone, company) VALUES (?, ?, ?, ?)').run(args.name, args.email ?? null, args.phone ?? null, args.company ?? null).lastInsertRowid;
      logActivity('created', 'contact', id, args.name);
      return { id };
    }
    case 'update_contact':
      db.prepare('UPDATE contacts SET name=?, email=?, phone=?, company=? WHERE id=?').run(args.name, args.email ?? null, args.phone ?? null, args.company ?? null, args.id);
      logActivity('updated', 'contact', args.id, args.name);
      return { success: true };
    case 'delete_contact': {
      const row = db.prepare('SELECT name FROM contacts WHERE id=?').get(args.id);
      db.prepare('DELETE FROM contacts WHERE id=?').run(args.id);
      logActivity('deleted', 'contact', args.id, row?.name);
      return { success: true };
    }
    case 'create_deal': {
      const id = db.prepare('INSERT INTO deals (title, amount, status, contact_id) VALUES (?, ?, ?, ?)').run(args.title, args.amount ?? null, args.status ?? 'new', args.contact_id ?? null).lastInsertRowid;
      logActivity('created', 'deal', id, args.title);
      return { id };
    }
    case 'update_deal':
      db.prepare('UPDATE deals SET title=?, amount=?, status=?, contact_id=? WHERE id=?').run(args.title, args.amount ?? null, args.status ?? 'new', args.contact_id ?? null, args.id);
      logActivity('updated', 'deal', args.id, args.title);
      return { success: true };
    case 'delete_deal': {
      const row = db.prepare('SELECT title FROM deals WHERE id=?').get(args.id);
      db.prepare('DELETE FROM deals WHERE id=?').run(args.id);
      logActivity('deleted', 'deal', args.id, row?.title);
      return { success: true };
    }
    case 'create_task': {
      const id = db.prepare('INSERT INTO tasks (description, deadline, status, contact_id) VALUES (?, ?, ?, ?)').run(args.description, args.deadline ?? null, args.status ?? 'pending', args.contact_id ?? null).lastInsertRowid;
      logActivity('created', 'task', id, args.description);
      return { id };
    }
    case 'update_task':
      db.prepare('UPDATE tasks SET description=?, deadline=?, status=?, contact_id=? WHERE id=?').run(args.description, args.deadline ?? null, args.status ?? 'pending', args.contact_id ?? null, args.id);
      logActivity('updated', 'task', args.id, args.description);
      return { success: true };
    case 'delete_task': {
      const row = db.prepare('SELECT description FROM tasks WHERE id=?').get(args.id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(args.id);
      logActivity('deleted', 'task', args.id, row?.description);
      return { success: true };
    }
    default:
      return { error: 'Unknown tool' };
  }
}

app.post('/chat', async (req, res) => {
  const { message, contact_id, deal_id } = req.body;

  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE contact_id IS ? AND deal_id IS ?
    ORDER BY created_at ASC LIMIT 50
  `).all(contact_id ?? null, deal_id ?? null);

  const systemPrompt = `You are an internal CRM assistant. You have full access to the database of contacts, deals, and tasks. You can add, update, and delete any records upon user request. Always confirm exactly what you did in the database. Reply in English.
Use tools for any database changes — do not describe actions in words, execute them.
IMPORTANT: pass names, surnames, company names, and any other data to the tools EXACTLY as the user wrote them — do not modify, correct, or substitute any word.
Current CRM data:

Contacts: ${JSON.stringify(db.prepare('SELECT * FROM contacts').all())}
Deals: ${JSON.stringify(db.prepare('SELECT * FROM deals').all())}
Tasks: ${JSON.stringify(db.prepare('SELECT * FROM tasks').all())}`;

  db.prepare('INSERT INTO messages (role, content, contact_id, deal_id) VALUES (?, ?, ?, ?)').run('user', message, contact_id ?? null, deal_id ?? null);

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
  db.prepare('INSERT INTO messages (role, content, contact_id, deal_id) VALUES (?, ?, ?, ?)').run('assistant', reply, contact_id ?? null, deal_id ?? null);

  res.json({ reply, toolsUsed });
});

// --- Users ---

app.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all());
});

app.post('/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role === 'admin' ? 'admin' : 'user');
    res.json({ id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Username already exists' });
  }
});

app.delete('/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.put('/users/:id/password', requireAuth, (req, res) => {
  const targetId = Number(req.params.id);
  if (req.user.role !== 'admin' && req.user.id !== targetId) return res.status(403).json({ error: 'Forbidden' });
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'New password too short' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.user.role !== 'admin' && !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), targetId);
  res.json({ success: true });
});

// --- Tags ---

app.get('/tags', (req, res) => {
  res.json(db.prepare('SELECT * FROM tags ORDER BY name ASC').all());
});

app.post('/tags', (req, res) => {
  const { name, color } = req.body;
  try {
    const result = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color || 'blue');
    res.json({ id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Tag name already exists' });
  }
});

app.delete('/tags/:id', (req, res) => {
  db.prepare('DELETE FROM tags WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/contacts/:id/tags', (req, res) => {
  const { tag_id } = req.body;
  try { db.prepare('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)').run(req.params.id, tag_id); } catch {}
  res.json({ success: true });
});

app.delete('/contacts/:id/tags/:tag_id', (req, res) => {
  db.prepare('DELETE FROM contact_tags WHERE contact_id=? AND tag_id=?').run(req.params.id, req.params.tag_id);
  res.json({ success: true });
});

app.post('/deals/:id/tags', (req, res) => {
  const { tag_id } = req.body;
  try { db.prepare('INSERT INTO deal_tags (deal_id, tag_id) VALUES (?, ?)').run(req.params.id, tag_id); } catch {}
  res.json({ success: true });
});

app.delete('/deals/:id/tags/:tag_id', (req, res) => {
  db.prepare('DELETE FROM deal_tags WHERE deal_id=? AND tag_id=?').run(req.params.id, req.params.tag_id);
  res.json({ success: true });
});

// --- Email status / test ---

app.get('/email/status', requireAdmin, (req, res) => {
  res.json({
    configured: mailerReady,
    smtp_host: process.env.SMTP_HOST || null,
    notify_email: process.env.NOTIFY_EMAIL || null,
  });
});

app.post('/email/test', requireAdmin, async (req, res) => {
  if (!mailer) return res.status(400).json({ error: 'Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL in .env' });
  try {
    await mailer.verify();
    await sendEmail('[CRM] Test email', emailHtml('Test Email', '<p>Email notifications are working correctly!</p>'));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Backup / Restore ---

app.get('/backup/download', requireAdmin, async (req, res) => {
  const tmpPath = path.join(__dirname, `crm_backup_${Date.now()}.db`);
  try {
    await db.backup(tmpPath);
    const date = new Date().toISOString().slice(0, 10);
    res.download(tmpPath, `crm_backup_${date}.db`, () => {
      try { fs.unlinkSync(tmpPath); } catch {}
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/backup/restore', requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 16) {
      return res.status(400).json({ error: 'No file received' });
    }
    if (!buf.slice(0, 15).toString('ascii').startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'Not a valid SQLite database file' });
    }
    try {
      fs.writeFileSync(path.join(__dirname, 'crm.db'), buf);
      logActivity('restored', 'backup', null, 'database');
      res.json({ ok: true });
      setTimeout(() => process.exit(0), 400);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// --- Pipeline Stages ---

app.get('/pipeline-stages', (req, res) => {
  res.json(db.prepare('SELECT * FROM pipeline_stages ORDER BY position').all());
});

app.post('/pipeline-stages', requireAdmin, (req, res) => {
  const { label, color = 'blue', is_won = 0, is_lost = 0 } = req.body;
  if (!label) return res.status(400).json({ error: 'label required' });
  const name = label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const maxPos = db.prepare('SELECT MAX(position) as m FROM pipeline_stages').get().m ?? -1;
  try {
    const result = db.prepare('INSERT INTO pipeline_stages (name, label, color, position, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, label, color, maxPos + 1, is_won ? 1 : 0, is_lost ? 1 : 0);
    logActivity('created', 'stage', result.lastInsertRowid, label);
    res.json(db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(result.lastInsertRowid));
  } catch {
    res.status(400).json({ error: 'Stage with this name already exists' });
  }
});

app.put('/pipeline-stages/:id', requireAdmin, (req, res) => {
  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.id);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const { label, color, position, is_won, is_lost } = req.body;
  db.prepare('UPDATE pipeline_stages SET label=?, color=?, position=?, is_won=?, is_lost=? WHERE id=?')
    .run(
      label ?? stage.label, color ?? stage.color, position ?? stage.position,
      is_won != null ? (is_won ? 1 : 0) : stage.is_won,
      is_lost != null ? (is_lost ? 1 : 0) : stage.is_lost,
      req.params.id
    );
  res.json(db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.id));
});

app.delete('/pipeline-stages/:id', requireAdmin, (req, res) => {
  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.id);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare('SELECT COUNT(*) as c FROM deals WHERE status = ?').get(stage.name).c;
  if (inUse > 0) return res.status(400).json({ error: `Cannot delete: ${inUse} deal(s) use this stage` });
  db.prepare('DELETE FROM pipeline_stages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Activity Log ---

app.get('/activity', (req, res) => {
  const { entity_type } = req.query;
  let query = 'SELECT * FROM activity_log';
  const params = [];
  if (entity_type) { query += ' WHERE entity_type = ?'; params.push(entity_type); }
  query += ' ORDER BY created_at DESC LIMIT 100';
  res.json(db.prepare(query).all(...params));
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

// --- Messages history ---

app.get('/messages', (req, res) => {
  const { contact_id, deal_id } = req.query;
  const messages = db.prepare(`
    SELECT * FROM messages WHERE contact_id IS ? AND deal_id IS ?
    ORDER BY created_at ASC
  `).all(contact_id ?? null, deal_id ?? null);
  res.json(messages);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
