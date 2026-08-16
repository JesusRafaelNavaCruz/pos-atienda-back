import { MPResponse, Terminal } from "@/types/mercadopago/types";
import { getMPClient } from "./client";

export class TerminalService {
    private client: ReturnType<typeof getMPClient>;

    constructor(accessToken: string) {
        this.client = getMPClient(accessToken);
    }

    // 1. Listar terminales de un comercio
    async listTerminals(params?: {
        store_id?: string;
        pos_id?: string;
        offset?: number;
        limit?: number;
    }): Promise<MPResponse<{ terminals: Terminal[]; paging: { total: number; limit: number; offset: number } }>> {
        return this.client.get('/terminals/v1/list', { params });
    }

    // 2. Activar modo PDV en una o varias terminales
    async setupTerminals(terminalIds: string[]): Promise<MPResponse<{ terminals: { id: string; operating_mode: string }[] }>> {
        return this.client.patch('/terminals/v1/setup', {
        terminals: terminalIds.map(id => ({ id, operating_mode: 'PDV' }))
        });
    }

    // 3. Obtener una terminal específica (Opcional, pero útil)
    async getTerminal(id: string): Promise<MPResponse<Terminal>> {
        return this.client.get<Terminal>(`/terminals/v1/${id}`);
    }    

}
