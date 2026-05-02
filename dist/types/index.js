//Errores de dominio 
export class AppError extends Error {
    code;
    statusCode;
    constructor(code, message, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.name = "AppError";
    }
}
//# sourceMappingURL=index.js.map