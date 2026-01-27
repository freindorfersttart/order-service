import { APIGatewayProxyHandler } from 'aws-lambda'

export const hello: APIGatewayProxyHandler = async () => {
	return {
		statusCode: 200,
		body: JSON.stringify({ message: 'Auth service rodando com sucesso' }),
	}
}
