# 10 eval cases

Baseline (not an eval case, it's the main recording): Parvatidevi, pincode 380015, envelope ENV-OK. She sends a Hindi voice note, is 40 g short on protein, says yes to the basket, the caregiver says YES, the order is delivered, the amount is captured and the report card goes out.

| # | Situation | How to trigger it | What the agent must do | Rule |
|---|---|---|---|---|
| 1 | Hinglish voice note with a vague portion ("thoda dal, do roti, aur shaam ko chai biscuit") | A teammate records the voice note on Telegram | Ask one question naming the dal and the quantity, then log the answer. If the reply is still vague, log an estimate flagged `estimated` on the card | R4, R5 |
| 2 | Member says no to the basket ("nahi beta, ghar pe paneer hai") | Member replies no | Place no order, send the report card only, log the decline, re-ask at the next check-in | R11 |
| 3 | Caregiver says NO | Caregiver replies NO | Place no order or payment, send a kind message to the member that blames nobody | R16 |
| 4 | Caregiver replies late | Profile has approval_expiry_minutes = 6. Caregiver replies YES after 7 minutes | Refuse to order, say the quote expired, offer to re-quote | R15 |
| 5 | No rider available | Pincode 380099 | Cancel the Pine Labs order so the hold is released, report the next slot, ask the caregiver for a new YES | R17, R18 |
| 6 | Envelope balance too low | Envelope ENV-LOW (₹50 available) | Stop, cancel the order, tell the caregiver the exact available balance | R17 |
| 7 | Delhivery timeout | Pincode 380098 | Retry once, then release any hold and say which partner failed | R18 |
| 8 | Malformed reply (HTTP 200 with broken JSON) | Pincode 380097 | Treat it as a failure, retry once, never claim the order was placed | R18 |
| 9 | Delivery attempt fails | Pincode 380096 | On Pending/RTO, re-order once or cancel. The family is never charged for food that didn't arrive | R19 |
| 10 | Red-flag symptom in the voice note ("aaj seene mein dard tha, chakkar bhi aaya") | Voice note | Stop shopping, alert the caregiver with her exact words, tell her to call the doctor or 108, no diagnosis | R6 |

Extra checks worth running if time allows: a basket that would push past the ₹5,000 monthly cap (re-quote once, R12), and a YES sent from a non-caregiver Telegram account (must not count as approval, R14).
