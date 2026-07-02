export interface EmailDeliveryRecipientResult {
  email: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
  message_id?: string;
}

export interface EmailDeliveryResult {
  attempted: boolean;
  enabled: boolean;
  recipients?: string[];
  sent?: number;
  failed?: number;
  skipped_reason?: string;
  results?: EmailDeliveryRecipientResult[];
}
