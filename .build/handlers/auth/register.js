"use strict";
// src/handlers/auth/register.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const prisma_1 = require("../../lib/prisma");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const handler = async (event) => {
    try {
        const body = JSON.parse(event.body || '{}');
        const { email, password, name, role, permissions } = body;
        if (!email || !password || !name || !role) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Campos obrigatórios: email, senha, nome e role' }),
            };
        }
        const existingUser = await prisma_1.prisma.auth_user.findUnique({ where: { email } });
        if (existingUser) {
            return {
                statusCode: 409,
                body: JSON.stringify({ error: 'Email já cadastrado' }),
            };
        }
        const hashedPassword = await bcryptjs_1.default.hash(password, 10);
        await prisma_1.prisma.auth_user.create({
            data: {
                email,
                password: hashedPassword,
                name,
                role,
                permissions, // não precisa stringificar, já é tipo Json
            },
        });
        return {
            statusCode: 201,
            body: JSON.stringify({ message: 'Usuário registrado com sucesso' }),
        };
    }
    catch (error) {
        console.error('Erro no register:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Erro interno ao registrar usuário' }),
        };
    }
};
exports.handler = handler;
