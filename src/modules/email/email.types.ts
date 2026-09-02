export interface EmailResponse {
  success: boolean;
  data: any;
  error: Error | null;
}

export interface BaseEmailData {
  email: string;
  name: string;
  tenantName: string;
}

export interface WelcomeEmailData extends BaseEmailData {
  tenantName: string;
  planCode: string;
  ownerName: string;
  ownerEmail: string;
}

export interface VerificationEmailData extends BaseEmailData {
  token: string;
}

export interface PasswordResetEmailData extends BaseEmailData {
  token: string;
}


export type EmailTemplateType = 
  | 'WELCOME'
  | 'VERIFICATION' 
  | 'PASSWORD_RESET'
  | 'CUSTOM';

export interface EmailSendOptions {
  to: string | string[];
  /** Opcional: si se omite, se usa el subject configurado en el template de Resend. */
  subject?: string;
  templateId: string;
  templateData: Record<string, string | number>;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
  }>;
}
