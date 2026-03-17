export class AuthError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "AuthError";
		this.status = status;
	}
}
