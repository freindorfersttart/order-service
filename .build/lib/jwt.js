"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserIdFromEvent = getUserIdFromEvent;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || 'secret';
function getUserIdFromEvent(event) {
    const authHeader = event.headers.Authorization || event.headers.authorization;
    if (!authHeader) {
        throw new Error('Token não fornecido');
    }
    const token = authHeader.replace('Bearer ', '');
    const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
    if (!decoded.userId) {
        throw new Error('Token inválido: userId ausente');
    }
    return decoded.userId;
}
