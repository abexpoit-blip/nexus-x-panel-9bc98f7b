import { api } from "@/lib/api";
import IprnSmsDeliveriesShared from "./IprnSmsDeliveriesShared";

export default function IprnSmsDeliveries() {
  return (
    <IprnSmsDeliveriesShared
      title="IPRN-SMS — OTP Deliveries"
      description="Every scraped OTP, the agent it matched, and whether it was credited or rejected."
      fetcher={api.iprnSmsDeliveries}
    />
  );
}