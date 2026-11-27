import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SEED_PRODUCTS = JSON.parse(readFileSync(resolve(ROOT, "data", "seed-products.json"), "utf8"));
const MAX_JSON_BYTES = 64 * 1024;
const DELIVERY_FEES = { office: 600, home: 850 };
const CATEGORY_IDS = new Set(["boys", "girls", "baby"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loadEnvironmentFile() {
  const file = resolve(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

async function readBody(request, limit = MAX_JSON_BYTES) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, "حجم الطلب أكبر من الحد المسموح.");
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "صيغة البيانات غير صالحة.");
  }
}

function validImageSource(value) {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 1000 || value.startsWith("//")) return false;
  if (/^https?:\/\//i.test(value)) return true;
  return !value.includes(":") && !value.startsWith("/");
}

function validateProduct(product, id) {
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new HttpError(400, "بيانات المنتج غير صالحة.");
  }
  const price = Number(product.price);
  const oldPrice = product.oldPrice == null || product.oldPrice === "" ? null : Number(product.oldPrice);
  if (
    !Number.isSafeInteger(id) || id < 1 ||
    typeof product.title !== "string" || !product.title.trim() || product.title.length > 100 ||
    typeof product.description !== "string" || !product.description.trim() || product.description.length > 300 ||
    !CATEGORY_IDS.has(product.category) ||
    !Number.isSafeInteger(price) || price < 0 ||
    (oldPrice !== null && (!Number.isSafeInteger(oldPrice) || oldPrice < 0)) ||
    typeof product.emoji !== "string" || product.emoji.length > 8 ||
    !validImageSource(product.image || "") ||
    !Array.isArray(product.colors) || product.colors.length < 1 || product.colors.length > 20 ||
    !Array.isArray(product.sizes) || product.sizes.length < 1 || product.sizes.length > 20
  ) {
    throw new HttpError(400, "حقول المنتج المطلوبة غير صالحة.");
  }

  const colors = product.colors.map(color => {
    const priceDelta = Number(color?.priceDelta);
    if (
      typeof color?.name !== "string" || !color.name.trim() || color.name.length > 40 ||
      !/^#[0-9A-Fa-f]{6}$/.test(color.hex || "") ||
      !Number.isSafeInteger(priceDelta) ||
      !validImageSource(color.image || "")
    ) {
      throw new HttpError(400, "بيانات لون المنتج غير صالحة.");
    }
    return { name: color.name.trim(), hex: color.hex, priceDelta, image: color.image || "" };
  });

  const sizes = product.sizes.map(size => {
    const priceDelta = Number(size?.priceDelta);
    if (
      typeof size?.name !== "string" || !size.name.trim() || size.name.length > 40 ||
      !Number.isSafeInteger(priceDelta)
    ) {
      throw new HttpError(400, "بيانات مقاس المنتج غير صالحة.");
    }
    return { name: size.name.trim(), priceDelta };
  });

  const minimumPrice = price +
    Math.min(...colors.map(color => color.priceDelta)) +
    Math.min(...sizes.map(size => size.priceDelta));
  if (minimumPrice < 0) throw new HttpError(400, "لا يمكن أن يكون سعر المنتج أقل من صفر.");

  return {
    id,
    title: product.title.trim(),
    category: product.category,
    description: product.description.trim(),
    price,
    oldPrice,
    image: product.image || "",
    emoji: product.emoji || "👕",
    colors,
    sizes
  };
}

function mapProduct(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    price: row.price,
    oldPrice: row.old_price,
    image: row.image,
    emoji: row.emoji,
    colors: JSON.parse(row.colors_json),
    sizes: JSON.parse(row.sizes_json)
  };
}

function paymentConfiguration(env) {
  const mode = env.CHARGILY_MODE || "test";
  const key = env.CHARGILY_SECRET_KEY || "";
  const baseUrl = mode === "live"
    ? "https://pay.chargily.net/api/v2"
    : "https://pay.chargily.net/test/api/v2";
  let publicUrl;
  try {
    publicUrl = new URL(env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`);
  } catch {
    return { configured: false, mode, reason: "PUBLIC_URL غير صالح." };
  }

  if (!["test", "live"].includes(mode)) {
    return { configured: false, mode, reason: "CHARGILY_MODE يجب أن يكون test أو live." };
  }
  if (mode === "live" && publicUrl.protocol !== "https:") {
    return { configured: false, mode, reason: "يتطلب وضع الإنتاج رابط PUBLIC_URL آمناً عبر HTTPS." };
  }
  if (!key.startsWith(`${mode}_sk_`)) {
    return { configured: false, mode, reason: "مفتاح Chargily غير موجود أو لا يطابق الوضع المحدد." };
  }
  return { configured: true, mode, key, baseUrl, publicUrl: publicUrl.origin };
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeCustomer(customer) {
  const name = typeof customer?.name === "string" ? customer.name.trim() : "";
  const phone = typeof customer?.phone === "string" ? customer.phone.trim() : "";
  const wilaya = typeof customer?.wilaya === "string" ? customer.wilaya.trim() : "";
  const address = typeof customer?.address === "string" ? customer.address.trim() : "";
  const compactPhone = phone.replace(/[\s()-]/g, "");
  if (!name || name.length > 100) throw new HttpError(400, "أدخل اسماً صحيحاً.");
  if (!/^(?:0[567]\d{8}|\+?213[567]\d{8})$/.test(compactPhone)) {
    throw new HttpError(400, "أدخل رقم هاتف جزائرياً صحيحاً.");
  }
  if (!wilaya || wilaya.length > 80) throw new HttpError(400, "أدخل الولاية أو المدينة.");
  if (address.length > 400) throw new HttpError(400, "العنوان أطول من الحد المسموح.");
  return { name, phone, wilaya, address };
}

function getOrderItems(db, inputItems) {
  if (!Array.isArray(inputItems) || inputItems.length < 1 || inputItems.length > 25) {
    throw new HttpError(400, "أضف من منتج واحد إلى 25 منتجاً للطلب.");
  }
  const findProduct = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1");
  return inputItems.map(input => {
    const productId = Number(input?.productId);
    const quantity = Number(input?.quantity);
    if (!Number.isSafeInteger(productId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new HttpError(400, "معرّف المنتج أو الكمية غير صالح.");
    }
    const row = findProduct.get(productId);
    if (!row) throw new HttpError(400, "أحد المنتجات لم يعد متاحاً.");
    const product = mapProduct(row);
    const color = product.colors.find(option => option.name === input.colorName);
    const size = product.sizes.find(option => option.name === input.sizeName);
    if (!color || !size) throw new HttpError(400, "اختيار اللون أو المقاس غير متاح.");
    const unitPrice = product.price + color.priceDelta + size.priceDelta;
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      throw new HttpError(400, "تعذر تحديد سعر هذا المنتج.");
    }
    return {
      productId,
      title: product.title,
      colorName: color.name,
      colorHex: color.hex,
      sizeName: size.name,
      unitPrice,
      quantity
    };
  });
}

function insertOrder(db, { customer, deliveryType, items, paymentMethod }) {
  if (!Object.hasOwn(DELIVERY_FEES, deliveryType)) {
    throw new HttpError(400, "نوع التوصيل غير صالح.");
  }
  const deliveryFee = DELIVERY_FEES[deliveryType];
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const total = subtotal + deliveryFee;
  if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(total) || total > 100_000_000) {
    throw new HttpError(400, "إجمالي الطلب خارج النطاق المسموح.");
  }

  const orderId = randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO orders
        (id, customer_name, phone, wilaya, address, delivery_type, delivery_fee, subtotal, total, status, payment_method, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, customer.name, customer.phone, customer.wilaya, customer.address,
      deliveryType, deliveryFee, subtotal, total,
      paymentMethod === "cod" ? "cod_pending" : "pending",
      paymentMethod, now, now
    );
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, title, color_name, color_hex, size_name, unit_price, quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    items.forEach(item => insertItem.run(
      orderId, item.productId, item.title, item.colorName, item.colorHex,
      item.sizeName, item.unitPrice, item.quantity
    ));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { id: orderId, deliveryType, deliveryFee, subtotal, total, items };
}

function getOrderSummary(db, orderId) {
  const order = db.prepare(`
    SELECT id, delivery_type, delivery_fee, subtotal, total, status, payment_method, chargily_checkout_id
    FROM orders WHERE id = ?
  `).get(orderId);
  if (!order) return null;
  const items = db.prepare(`
    SELECT product_id AS productId, title, color_name AS colorName, color_hex AS colorHex,
      size_name AS sizeName, unit_price AS unitPrice, quantity
    FROM order_items WHERE order_id = ?
  `).all(orderId);
  return {
    id: order.id,
    deliveryType: order.delivery_type,
    deliveryFee: order.delivery_fee,
    subtotal: order.subtotal,
    total: order.total,
    status: order.status,
    paymentMethod: order.payment_method,
    checkoutId: order.chargily_checkout_id,
    items
  };
}

function updatePaymentStatus(db, orderId, status) {
  db.prepare(`
    UPDATE orders SET status = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, new Date().toISOString(), orderId);
}

async function requestChargily(config, path, options = {}) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}/${path}`, {
      ...options,
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${config.key}`,
        "content-type": "application/json",
        ...options.headers
      }
    });
  } catch (error) {
    console.error("Chargily request failed:", error);
    throw new HttpError(502, "تعذر الاتصال بمزود الدفع. حاول مرة أخرى لاحقاً.");
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(502, "أعاد مزود الدفع استجابة غير مفهومة.");
  }
  if (!response.ok) {
    console.error("Chargily API error:", response.status, data.message || response.statusText);
    throw new HttpError(502, "تعذر إنشاء جلسة الدفع لدى Chargily.");
  }
  return data;
}

function createApplication(options = {}) {
  const env = options.env || process.env;
  const port = Number(env.PORT || 3000);
  const configuredDbPath = options.databasePath || env.DB_PATH || "./data/store.sqlite";
  const databasePath = configuredDbPath === ":memory:"
    ? configuredDbPath
    : resolve(ROOT, configuredDbPath);
  if (databasePath !== ":memory:") mkdirSync(resolve(databasePath, ".."), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('boys', 'girls', 'baby')),
      description TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      old_price INTEGER,
      image TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL DEFAULT '👕',
      colors_json TEXT NOT NULL,
      sizes_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      wilaya TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      delivery_type TEXT NOT NULL,
      delivery_fee INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      chargily_checkout_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      color_name TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      size_name TEXT NOT NULL,
      unit_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_webhooks (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
  `);

  const insertSeed = db.prepare(`
    INSERT OR IGNORE INTO products
      (id, title, category, description, price, old_price, image, emoji, colors_json, sizes_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seedTime = new Date().toISOString();
  for (const seed of SEED_PRODUCTS) {
    insertSeed.run(
      seed.id, seed.title, seed.category, seed.description, seed.price, seed.oldPrice,
      seed.image, seed.emoji, JSON.stringify(seed.colors), JSON.stringify(seed.sizes), seedTime
    );
  }

  const payment = paymentConfiguration(env);
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const pathname = requestUrl.pathname;

      if (request.method === "GET" && pathname === "/api/health") {
        return sendJson(response, 200, {
          database: "connected",
          payments: {
            provider: "chargily",
            mode: payment.mode,
            configured: payment.configured
          }
        });
      }

      if (request.method === "GET" && pathname === "/api/products") {
        const products = db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY id").all().map(mapProduct);
        return sendJson(response, 200, products);
      }

      if (request.method === "POST" && pathname === "/api/orders") {
        const body = await readJson(request);
        const customer = normalizeCustomer(body.customer);
        const items = getOrderItems(db, body.items);
        const order = insertOrder(db, {
          customer,
          deliveryType: body.deliveryType,
          items,
          paymentMethod: "cod"
        });
        return sendJson(response, 201, {
          id: order.id,
          status: "cod_pending",
          deliveryType: order.deliveryType,
          deliveryFee: order.deliveryFee,
          subtotal: order.subtotal,
          total: order.total,
          items: order.items
        });
      }

      if (request.method === "POST" && pathname === "/api/payments/checkout") {
        if (!payment.configured) {
          throw new HttpError(503, `الدفع الإلكتروني غير مهيأ: ${payment.reason}`);
        }
        const body = await readJson(request);
        const customer = normalizeCustomer(body.customer);
        const items = getOrderItems(db, body.items);
        const order = insertOrder(db, {
          customer,
          deliveryType: body.deliveryType,
          items,
          paymentMethod: "chargily"
        });
        const successUrl = new URL("/index.html", payment.publicUrl);
        successUrl.searchParams.set("payment", "success");
        successUrl.searchParams.set("order_id", order.id);
        const failureUrl = new URL("/index.html", payment.publicUrl);
        failureUrl.searchParams.set("payment", "failure");
        failureUrl.searchParams.set("order_id", order.id);
        const checkoutPayload = {
          amount: order.total,
          currency: "dzd",
          locale: "ar",
          description: `طلب متجر عالم الصغار ${order.id}`,
          success_url: successUrl.toString(),
          failure_url: failureUrl.toString(),
          metadata: { order_id: order.id }
        };
        if (payment.publicUrl.startsWith("https://")) {
          checkoutPayload.webhook_endpoint = `${payment.publicUrl}/api/webhooks/chargily`;
        }

        try {
          const checkout = await requestChargily(payment, "checkouts", {
            method: "POST",
            body: JSON.stringify(checkoutPayload)
          });
          const checkoutUrl = new URL(checkout.checkout_url);
          if (
            checkoutUrl.protocol !== "https:" ||
            !/(^|\.)chargily\.(?:dz|net)$/i.test(checkoutUrl.hostname) ||
            typeof checkout.id !== "string"
          ) {
            throw new HttpError(502, "أعاد مزود الدفع رابطاً غير صالح.");
          }
          db.prepare(`
            UPDATE orders SET chargily_checkout_id = ?, updated_at = ? WHERE id = ?
          `).run(checkout.id, new Date().toISOString(), order.id);
          return sendJson(response, 201, { orderId: order.id, checkoutUrl: checkoutUrl.toString() });
        } catch (error) {
          updatePaymentStatus(db, order.id, "payment_failed");
          throw error;
        }
      }

      if (request.method === "GET" && pathname.startsWith("/api/orders/") && pathname.endsWith("/status")) {
        const orderId = pathname.slice("/api/orders/".length, -"/status".length);
        if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(400, "معرّف الطلب غير صالح.");
        const order = getOrderSummary(db, orderId);
        if (!order) throw new HttpError(404, "الطلب غير موجود.");
        if (order.paymentMethod === "chargily" && order.status === "pending" && order.checkoutId) {
          if (!payment.configured) throw new HttpError(503, "تعذر التحقق من الدفع حالياً.");
          const checkout = await requestChargily(payment, `checkouts/${encodeURIComponent(order.checkoutId)}`);
          if (checkout.status === "paid") {
            if (Number(checkout.amount) !== order.total || String(checkout.currency).toLowerCase() !== "dzd") {
              throw new HttpError(502, "لم تتطابق قيمة الدفع مع إجمالي الطلب.");
            }
            updatePaymentStatus(db, order.id, "paid");
            order.status = "paid";
          } else if (["failed", "canceled"].includes(checkout.status)) {
            updatePaymentStatus(db, order.id, `payment_${checkout.status}`);
            order.status = `payment_${checkout.status}`;
          }
        }
        return sendJson(response, 200, {
          id: order.id,
          status: order.status,
          paymentMethod: order.paymentMethod,
          subtotal: order.subtotal,
          deliveryFee: order.deliveryFee,
          total: order.total,
          currency: "DZD"
        });
      }

      if (request.method === "POST" && pathname === "/api/webhooks/chargily") {
        if (!payment.configured) throw new HttpError(503, "معالج الدفع غير مهيأ.");
        const rawBody = await readBody(request);
        const signature = request.headers.signature;
        const expected = createHmac("sha256", payment.key).update(rawBody).digest("hex");
        if (!secureEqual(signature, expected)) throw new HttpError(403, "توقيع إشعار الدفع غير صالح.");
        let event;
        try {
          event = JSON.parse(rawBody.toString("utf8"));
        } catch {
          throw new HttpError(400, "محتوى إشعار الدفع غير صالح.");
        }
        if (typeof event.id !== "string" || typeof event.type !== "string" || typeof event.data?.id !== "string") {
          throw new HttpError(400, "حقول إشعار الدفع المطلوبة غير موجودة.");
        }
        const eventLivemode = event.data.livemode ?? event.livemode;
        if (eventLivemode != null && Boolean(eventLivemode === true || eventLivemode === "true") !== (payment.mode === "live")) {
          throw new HttpError(400, "وضع إشعار الدفع لا يطابق إعداد المتجر.");
        }
        const alreadyProcessed = db.prepare("SELECT 1 FROM processed_webhooks WHERE event_id = ?").get(event.id);
        if (alreadyProcessed) return sendJson(response, 200, { received: true });
        const order = db.prepare("SELECT * FROM orders WHERE chargily_checkout_id = ?").get(event.data.id);
        if (!order) throw new HttpError(404, "الطلب المرتبط بإشعار الدفع غير موجود.");

        let newStatus = null;
        if (event.type === "checkout.paid") {
          if (
            event.data.status !== "paid" ||
            Number(event.data.amount) !== order.total ||
            String(event.data.currency).toLowerCase() !== "dzd"
          ) {
            throw new HttpError(400, "بيانات الدفع لا تطابق الطلب.");
          }
          newStatus = "paid";
        } else if (event.type === "checkout.failed") {
          newStatus = "payment_failed";
        } else if (event.type === "checkout.canceled") {
          newStatus = "payment_canceled";
        }

        db.exec("BEGIN IMMEDIATE");
        try {
          if (newStatus) updatePaymentStatus(db, order.id, newStatus);
          db.prepare("INSERT INTO processed_webhooks (event_id, processed_at) VALUES (?, ?)")
            .run(event.id, new Date().toISOString());
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(response, 200, { received: true });
      }

      if (
        pathname === "/api/admin/products" ||
        /^\/api\/admin\/products\/\d+$/.test(pathname)
      ) {
        if (!env.ADMIN_API_KEY) throw new HttpError(503, "إدارة المنتجات عبر قاعدة البيانات غير مهيأة.");
        if (!secureEqual(request.headers["x-admin-api-key"], env.ADMIN_API_KEY)) {
          throw new HttpError(401, "مفتاح إدارة المنتجات غير صحيح.");
        }
        if (request.method === "POST" && pathname === "/api/admin/products") {
          const body = await readJson(request);
          const id = Number(body.id);
          const product = validateProduct(body, id);
          db.prepare(`
            INSERT INTO products
              (id, title, category, description, price, old_price, image, emoji, colors_json, sizes_json, active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              title=excluded.title, category=excluded.category, description=excluded.description,
              price=excluded.price, old_price=excluded.old_price, image=excluded.image,
              emoji=excluded.emoji, colors_json=excluded.colors_json, sizes_json=excluded.sizes_json,
              active=1, updated_at=excluded.updated_at
          `).run(
            product.id, product.title, product.category, product.description, product.price,
            product.oldPrice, product.image, product.emoji, JSON.stringify(product.colors),
            JSON.stringify(product.sizes), new Date().toISOString()
          );
          return sendJson(response, 200, product);
        }
        const match = pathname.match(/^\/api\/admin\/products\/(\d+)$/);
        if (match && request.method === "DELETE") {
          const result = db.prepare("UPDATE products SET active = 0, updated_at = ? WHERE id = ? AND active = 1")
            .run(new Date().toISOString(), Number(match[1]));
          if (!result.changes) throw new HttpError(404, "المنتج غير موجود.");
          return sendJson(response, 200, { deleted: true });
        }
      }

      if (request.method === "GET") return serveStatic(pathname, response);
      throw new HttpError(404, "المسار المطلوب غير موجود.");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof HttpError)) {
        console.error("Request failed:", error);
      }
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : "حدث خطأ داخلي في الخادم."
      });
    }
  });

  function serveStatic(pathname, response) {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "مسار الصفحة غير صالح.");
    }
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/\\]+/, "");
    const file = resolve(ROOT, relativePath);
    const relativePathFromRoot = relative(ROOT, file);
    if (
      relativePathFromRoot.startsWith(`..${sep}`) ||
      relativePathFromRoot === ".." ||
      /(^|[/\\])(?:\.env[^/\\]*|data|node_modules|tests|\.git)([/\\]|$)/i.test(relativePathFromRoot) ||
      /(^|[/\\])(?:server\.js|package(?:-lock)?\.json|\.gitignore)$/i.test(relativePathFromRoot)
    ) {
      throw new HttpError(404, "الملف غير موجود.");
    }
    let fileInfo;
    try {
      fileInfo = statSync(file);
    } catch {
      throw new HttpError(404, "الملف غير موجود.");
    }
    if (!fileInfo.isFile()) throw new HttpError(404, "الملف غير موجود.");
    const content = readFileSync(file);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": content.length,
      "x-content-type-options": "nosniff",
      "cache-control": extname(file).toLowerCase() === ".html" ? "no-cache" : "public, max-age=3600"
    });
    response.end(content);
  }

  return {
    server,
    db,
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close(error => {
          if (error) {
            rejectClose(error);
            return;
          }
          db.close();
          resolveClose();
        });
      });
    }
  };
}

loadEnvironmentFile();

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApplication();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  app.server.listen(port, host, () => {
    console.log(`KIDS Store is available at http://${host}:${port}`);
    console.log(`SQLite database: ${process.env.DB_PATH || "./data/store.sqlite"}`);
    if (!paymentConfiguration(process.env).configured) {
      console.warn("Chargily checkout is disabled until valid environment keys are configured.");
    }
  });
  const shutdown = () => app.server.close(() => {
    app.db.close();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { createApplication, HttpError };
