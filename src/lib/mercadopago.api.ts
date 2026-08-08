import { envMP } from "@/config/mercadopago.config";

const MP_API = envMP.MP_API_URL || "https://api.mercadopago.com";
const TOKEN = envMP.MP_ACCESS_TOKEN;

function headers(idempotencyKey?: string) {
    const h: Record<string, string> = {
        Autorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
    }
    if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
    return h;
}

export async function listTerminals() {
    const res = await fetch(`${MP_API}/terminals/v1/list`, {
        method: "GET",
        headers: headers(),
    });
    if (!res.ok) throw new Error(`MP Orders API ${res.status}`);
    return res.json();
}



export async function createOrder(payload: any, idempotencyKey?: string) {
    const res = await fetch(`${MP_API}/v1/orders`, {
        method: "POST",
        headers: headers(idempotencyKey),
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`MP Orders API ${res.status}`);
    return res.json();
}