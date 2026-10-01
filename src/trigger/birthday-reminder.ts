import { logger, task } from "@trigger.dev/sdk";
import { BIRTHDAY_REMINDER_TYPE } from "../lib/supabase/reminder-logs.js";
import {
  fetchActiveBirthdayCustomersToday,
  getTodayIsoDateInSaoPaulo,
  type Customer,
} from "../lib/supabase/customers.js";
import { buildBirthdayReminderMessage } from "../lib/whatsapp/templates.js";
import { getZApiConfig } from "../lib/whatsapp/zapi.js";
import {
  runTextReminderWorkflow,
  type ReminderTaskInput,
} from "../lib/reminders/shared.js";

type BirthdayReminderTaskInput = ReminderTaskInput<Customer>;

const BIRTHDAY_CUSTOMER_KEYS = ["nr_contrato"];

export function getBirthdayReminderIdentity(customer: Customer): string | null {
  const document = String(customer.nm_cpfcnpj_consorciado ?? "").replace(/\D/g, "");
  if (document) return document;

  const contract = String(customer.nr_contrato ?? "").trim();
  return contract || null;
}

export const birthdayReminder = task({
  id: "birthday-reminder",
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    return runTextReminderWorkflow({
      payload: payload as BirthdayReminderTaskInput,
      requiredCustomerKeys: BIRTHDAY_CUSTOMER_KEYS,
      reminderType: BIRTHDAY_REMINDER_TYPE,
      referenceDate: (asOfDate) => asOfDate ?? getTodayIsoDateInSaoPaulo(),
      logger,
      label: "Birthday reminder",
      fetchCustomers: fetchActiveBirthdayCustomersToday,
      buildMessage: (customer) => buildBirthdayReminderMessage(customer.nm_consorciado),
      getContract: (customer) => customer.nr_contrato,
      getIdempotencyKeyValue: getBirthdayReminderIdentity,
      getName: (customer) => customer.nm_consorciado,
      getPhoneValue: (customer) => customer.cd_whatsapp,
      zapiConfig: getZApiConfig(),
    });
  },
});
