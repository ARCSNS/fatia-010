import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from './db.js';
import { requireAdmin } from './auth.js';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'https://fatia-010.onrender.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres.');
}

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origem não permitida pelo CORS.'));
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use('/api/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'fatia-010-api', database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, service: 'fatia-010-api', database: 'unavailable' });
  }
});

app.get('/api/catalog', async (_req, res, next) => {
  try {
    const categories = await pool.query(
      `SELECT id, name, slug
       FROM categories WHERE active = TRUE
       ORDER BY name`
    );
    const products = await pool.query(
      `SELECT id, category_id, name, slug, description, price, image_url, available, sort_order
       FROM products
       WHERE active = TRUE AND available = TRUE
       ORDER BY sort_order, name`
    );
    res.json({ categories: categories.rows, products: products.rows });
  } catch (err) { next(err); }
});

app.get('/api/neighborhoods', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, delivery_fee FROM neighborhoods
       WHERE active = TRUE ORDER BY name`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

app.get('/api/payment-methods', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM payment_methods WHERE active = TRUE ORDER BY name`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

app.post('/api/orders', async (req, res, next) => {
  const { customer, neighborhoodId, paymentMethodId, deliveryAddress, notes, items } = req.body || {};
  if (!customer?.name || !customer?.phone || !neighborhoodId || !paymentMethodId ||
      !deliveryAddress || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe cliente, bairro, pagamento, endereço e itens.' });
  }
  if (items.length > 30) return res.status(400).json({ error: 'Limite de 30 itens por pedido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const neighborhood = await client.query(
      'SELECT id, delivery_fee FROM neighborhoods WHERE id = $1 AND active = TRUE FOR SHARE',
      [neighborhoodId]
    );
    if (!neighborhood.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bairro indisponível.' });
    }

    const payment = await client.query(
      'SELECT id FROM payment_methods WHERE id = $1 AND active = TRUE',
      [paymentMethodId]
    );
    if (!payment.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Forma de pagamento indisponível.' });
    }

    const productIds = [...new Set(items.map((item) => Number(item.productId)))];
    if (productIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Produto inválido.' });
    }
    const productResult = await client.query(
      `SELECT id, name, price FROM products
       WHERE id = ANY($1::bigint[]) AND active = TRUE AND available = TRUE
       FOR SHARE`,
      [productIds]
    );
    const productMap = new Map(productResult.rows.map((p) => [String(p.id), p]));
    if (productMap.size !== productIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Um ou mais produtos não estão disponíveis.' });
    }

    let subtotal = 0;
    const normalizedItems = [];
    for (const item of items) {
      const product = productMap.get(String(Number(item.productId)));
      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Quantidade inválida.' });
      }
      const unitPrice = Number(product.price);
      const lineSubtotal = Math.round(unitPrice * quantity * 100) / 100;
      subtotal += lineSubtotal;
      normalizedItems.push({ product, quantity, unitPrice, lineSubtotal, observations: item.observations || null });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const deliveryFee = Number(neighborhood.rows[0].delivery_fee);
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;

    const customerResult = await client.query(
      `SELECT id FROM customers WHERE phone = $1 ORDER BY id LIMIT 1`,
      [String(customer.phone).trim()]
    );
    let customerId;
    if (customerResult.rowCount) {
      customerId = customerResult.rows[0].id;
      await client.query('UPDATE customers SET name = $1 WHERE id = $2', [String(customer.name).trim(), customerId]);
    } else {
      const insertedCustomer = await client.query(
        `INSERT INTO customers (name, phone, created_at) VALUES ($1, $2, NOW()) RETURNING id`,
        [String(customer.name).trim(), String(customer.phone).trim()]
      );
      customerId = insertedCustomer.rows[0].id;
    }

    const orderResult = await client.query(
      `INSERT INTO orders
       (customer_id, neighborhood_id, payment_method_id, delivery_address, notes,
        subtotal, delivery_fee, total, status, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'recebido','site',NOW(),NOW())
       RETURNING id, order_number, status, subtotal, delivery_fee, total, created_at`,
      [customerId, neighborhoodId, paymentMethodId, String(deliveryAddress).trim(),
       notes ? String(notes).trim() : null, subtotal, deliveryFee, total]
    );
    const order = orderResult.rows[0];

    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO order_items
         (order_id, product_id, product_name, quantity, unit_price, subtotal, observations, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [order.id, item.product.id, item.product.name, item.quantity,
         item.unitPrice, item.lineSubtotal, item.observations]
      );
    }

    await client.query(
      `INSERT INTO order_status_history (order_id, old_status, new_status, changed_at)
       VALUES ($1, NULL, 'recebido', NOW())`,
      [order.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Pedido recebido.', order });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.post('/api/admin/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
    const result = await pool.query(
      'SELECT id, username, password_hash FROM administrators WHERE username = $1 AND active = TRUE',
      [String(username).trim()]
    );
    if (!result.rowCount || !(await bcrypt.compare(String(password), result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }
    const admin = result.rows[0];
    const token = jwt.sign({ sub: String(admin.id), username: admin.username }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, administrator: { id: admin.id, username: admin.username } });
  } catch (err) { next(err); }
});

app.get('/api/admin/orders', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.source, o.subtotal, o.delivery_fee, o.total,
              o.delivery_address, o.notes, o.created_at,
              c.name AS customer_name, c.phone AS customer_phone,
              n.name AS neighborhood, pm.name AS payment_method,
              COALESCE(json_agg(json_build_object(
                'product_name', oi.product_name, 'quantity', oi.quantity,
                'unit_price', oi.unit_price, 'subtotal', oi.subtotal,
                'observations', oi.observations
              )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN neighborhoods n ON n.id = o.neighborhood_id
       LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       GROUP BY o.id, c.name, c.phone, n.name, pm.name
       ORDER BY o.created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

const allowedStatuses = new Set(['recebido', 'em_preparo', 'saiu_para_entrega', 'entregue', 'cancelado']);
app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res, next) => {
  const orderId = Number(req.params.id);
  const newStatus = req.body?.status;
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !allowedStatuses.has(newStatus)) {
    return res.status(400).json({ error: 'Pedido ou status inválido.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    const oldStatus = current.rows[0].status;
    await client.query(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
      [newStatus, orderId]
    );
    await client.query(
      'INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1,$2,$3,NOW())',
      [orderId, oldStatus, newStatus]
    );
    await client.query('COMMIT');
    res.json({ message: 'Status atualizado.', orderId, oldStatus, newStatus });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// Bootstrap opcional: cria o primeiro administrador sem armazenar senha em texto puro.
async function ensureInitialAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('ADMIN_USERNAME/ADMIN_PASSWORD ausentes; criação inicial de administrador ignorada.');
    return;
  }
  const exists = await pool.query('SELECT 1 FROM administrators WHERE username = $1', [username]);
  if (exists.rowCount) return;
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO administrators (username, password_hash, active, created_at) VALUES ($1,$2,TRUE,NOW())',
    [username, hash]
  );
  console.log('Administrador inicial criado.');
}

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.message === 'Origem não permitida pelo CORS') {
    return res.status(403).json({ error: 'Origem não permitida.' });
  }
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

await ensureInitialAdmin();
app.listen(PORT, () => console.log(`FATIA 010 API ouvindo na porta ${PORT}`));
