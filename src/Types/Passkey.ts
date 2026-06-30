export type PasskeyAssertion = {
	credentialId: Buffer
	assertionJson: Buffer | string
}

export type PasskeyRequest = {
	phone?: string
	bridgeId: string
	requestOptions: Buffer
}

export type PasskeyConfirmation = {
	phone?: string
	bridgeId?: string
	code: string
	skipHandoffUX: boolean
}

export type PasskeyUpdate =
	| {
			status: 'request'
			phone?: string
			bridgeId: string
			requestOptions: Buffer
	  }
	| {
			status: 'response-sent'
			phone?: string
			bridgeId?: string
	  }
	| {
			status: 'confirmation'
			phone?: string
			bridgeId?: string
			code: string
			skipHandoffUX: boolean
	  }
	| {
			status: 'completed'
			phone?: string
			bridgeId?: string
	  }
	| {
			status: 'timeout' | 'error'
			phone?: string
			bridgeId?: string
			error: string
	  }
