import { EMAIL_CONFIG, resend } from "@/config/email.config";
import { EmailResponse, EmailSendOptions } from "./email.types";

export class EmailService {
  private static instance: EmailService;

  private constructor() {}

  static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }

  async sendEmail({
    to,
    subject,
    templateId,
    templateData,
    from = EMAIL_CONFIG.from,
  }: EmailSendOptions): Promise<EmailResponse> {

    try {

        const { data, error } = await resend.emails.send({
            from,
            to: Array.isArray(to) ? to : [to],
            subject,
            template: {
                id: templateId,
                variables: templateData,
            },
        });

        if (error) {
            throw new Error(`Error sending email: ${error.message}`);
        }

        return { success: true, data, error: null };

    } catch (error) {
      console.error('Email send error:', error);
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error : new Error('Unknown error')
      };
    }

  }
}
