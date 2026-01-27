"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hello = void 0;
const hello = async () => {
    return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Auth service rodando com sucesso' }),
    };
};
exports.hello = hello;
