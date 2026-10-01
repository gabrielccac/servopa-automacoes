import { logger, task } from "@trigger.dev/sdk";
import { CONTEMPLATION_REMINDER_TYPE } from "../lib/supabase/reminder-logs.js";
import {
  fetchActiveContemplationCustomersToday,
  getTodayIsoDateInSaoPaulo,
  type Customer,
} from "../lib/supabase/customers.js";
import { buildContemplationReminderMessage } from "../lib/whatsapp/templates.js";
import { getZApiConfig } from "../lib/whatsapp/zapi.js";
import {
  runTextReminderWorkflow,
  type ReminderTaskInput,
} from "../lib/reminders/shared.js";

type ContemplationReminderTaskInput = ReminderTaskInput<Customer>;

const CONTEMPLATION_CUSTOMER_KEYS = ["nr_contrato"];

export const contemplationReminder = task({
  id: "contemplation-reminder",
  maxDuration: 300,
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => {
    return runTextReminderWorkflow({
      payload: payload as ContemplationReminderTaskInput,
      requiredCustomerKeys: CONTEMPLATION_CUSTOMER_KEYS,
      reminderType: CONTEMPLATION_REMINDER_TYPE,
      referenceDate: (asOfDate) => asOfDate ?? getTodayIsoDateInSaoPaulo(),
      logger,
      label: "Contemplation reminder",
      fetchCustomers: fetchActiveContemplationCustomersToday,
      buildMessage: (customer) =>
        buildContemplationReminderMessage(
          customer.nm_consorciado,
          customer.nr_cota,
          customer.nr_contrato,
        ),
      getContract: (customer) => customer.nr_contrato,
      getName: (customer) => customer.nm_consorciado,
      getPhoneValue: (customer) => customer.cd_whatsapp,
      zapiConfig: getZApiConfig(),
    });
  },
});
