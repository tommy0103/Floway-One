export class ClientSafeBadRequestError extends Error {
  readonly clientMessage: string;

  constructor(internalMessage: string, clientMessage: string, cause: unknown) {
    super(internalMessage, { cause });
    this.name = 'ClientSafeBadRequestError';
    this.clientMessage = clientMessage;
  }
}
