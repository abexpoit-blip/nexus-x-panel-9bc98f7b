import { api } from "@/lib/api";
import IprnSmsDeliveriesShared from "./IprnSmsDeliveriesShared";

export default function IprnSmsV2Deliveries() {
  return (
    <IprnSmsDeliveriesShared
      title="IPRN-SMS V2 — OTP Deliveries"
      description="Every scraped OTP, the agent it matched, and whether it was credited or rejected."
      fetcher={api.iprnSmsV2Deliveries}
    />
  );
}