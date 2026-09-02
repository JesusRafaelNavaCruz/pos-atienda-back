import { Resend } from "resend";
import { env } from "./env.js";

export const resend = new Resend(env.RESEND_API_KEY);

export const EMAIL_CONFIG = {
    from: env.RESEND_FROM_EMAIL,
    baseUrl: env.FRONTEND_URL,
    templates: {
        WELCOME: env.RESEND_TEMPLATE_ID_WELCOME,
        VERIFICATION: env.RESEND_TEMPLATE_ID_VERIFICATION,
        PASSWORD_RESET: env.RESEND_TEMPLATE_ID_PASSWORD_RESET,
    }

}
