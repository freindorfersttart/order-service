"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const prisma_1 = require("../../lib/prisma");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || 'chave-secreta-dev'; // troque isso no ambiente real!
const handler = async (event) => {
    try {
        const body = JSON.parse(event.body || '{}');
        const { email, password } = body;
        if (!email || !password) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Email e senha são obrigatórios' }),
            };
        }
        const user = await prisma_1.prisma.auth_user.findUnique({ where: { email } });
        if (!user) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Credenciais inválidas' }),
            };
        }
        const isPasswordValid = await bcryptjs_1.default.compare(password, user.password);
        if (!isPasswordValid) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Credenciais inválidas' }),
            };
        }
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
        return {
            statusCode: 200,
            body: JSON.stringify({ token }),
        };
    }
    catch (error) {
        console.error('Erro no login:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Erro interno ao realizar login' }),
        };
    }
};
exports.handler = handler;
