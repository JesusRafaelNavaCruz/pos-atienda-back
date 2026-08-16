const MP_API = "https://api.mercadopago.com";

function headers(accessToken: string, idempotencyKey?: string) {
    const h: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
    }
    if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
    return h;
}

export async function listTerminals(accessToken: string) {
    const res = await fetch(`${MP_API}/terminals/v1/list`, {
        method: "GET",
        headers: headers(accessToken),
    });
    if (!res.ok) throw new Error(`MP Orders API ${res.status}`);
    return res.json();
}



export async function createOrder(accessToken: string, payload: any, idempotencyKey?: string) {
    const res = await fetch(`${MP_API}/v1/orders`, {
        method: "POST",
        headers: headers(accessToken, idempotencyKey),
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`MP Orders API ${res.status}`);
    return res.json();
}
