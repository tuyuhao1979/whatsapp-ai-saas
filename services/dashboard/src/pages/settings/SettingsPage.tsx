import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { tenant, dryRun } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const connectSchema = z.object({
  waba_id: z.string().min(1, "Obligatorio"),
  phone_number_id: z.string().min(1, "Obligatorio"),
  access_token: z.string().min(1, "Obligatorio"),
});
type ConnectForm = z.infer<typeof connectSchema>;

export function SettingsPage() {
  const qc = useQueryClient();
  const [dryRunMsg, setDryRunMsg] = useState("");
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [dryRunRunning, setDryRunRunning] = useState(false);

  const { data: tenantData } = useQuery({
    queryKey: ["tenant"],
    queryFn: tenant.get,
  });

  const connected = Boolean(tenantData?.whatsapp?.connected ?? tenantData?.phone_number_id);

  const connectMut = useMutation({
    mutationFn: (data: ConnectForm) => tenant.connectWhatsApp(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant"] });
      toast.success("WhatsApp conectado");
    },
    onError: (e) => toast.error("No se pudo conectar", e.message),
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConnectForm>({ resolver: zodResolver(connectSchema) });

  async function handleDryRun() {
    if (!dryRunMsg.trim()) return;
    setDryRunRunning(true);
    setDryRunResult(null);
    try {
      const res = await dryRun(dryRunMsg);
      setDryRunResult(res.reply);
      toast.success("Prueba completada");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error desconocido";
      setDryRunResult(`Error: ${msg}`);
      toast.error("Error en la prueba", msg);
    } finally {
      setDryRunRunning(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Cuenta</CardTitle>
          <CardDescription>Datos de tu negocio en la plataforma</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {tenantData ? (
            <>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
                <span className="text-muted-foreground sm:w-36 shrink-0">Nombre</span>
                <span className="font-medium">{tenantData.name}</span>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
                <span className="text-muted-foreground sm:w-36 shrink-0">Identificador</span>
                <span className="font-mono text-xs break-all">{tenantData.slug}</span>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-2 items-start">
                <span className="text-muted-foreground sm:w-36 shrink-0">Plan</span>
                <Badge variant="outline">{tenantData.plan}</Badge>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-2 items-start">
                <span className="text-muted-foreground sm:w-36 shrink-0">WhatsApp</span>
                {connected ? (
                  <Badge variant="success">Conectado · {tenantData.whatsapp?.phone_number_id ?? tenantData.phone_number_id}</Badge>
                ) : (
                  <Badge variant="warning">Sin conectar</Badge>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">Cargando…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conectar WhatsApp</CardTitle>
          <CardDescription>
            Vincula tu cuenta de Meta para recibir y enviar mensajes
          </CardDescription>
        </CardHeader>
        <CardContent>
          {connected ? (
            <p className="text-sm text-muted-foreground">
              WhatsApp ya está conectado. Puedes actualizar los datos enviando el formulario de
              nuevo.
            </p>
          ) : null}
          <form
            onSubmit={handleSubmit((d) => connectMut.mutate(d))}
            className="space-y-4 mt-4"
          >
            <div className="space-y-2">
              <Label>WABA ID</Label>
              <Input placeholder="123456789" {...register("waba_id")} />
              {errors.waba_id && (
                <p className="text-xs text-destructive">{errors.waba_id.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>ID del número de teléfono</Label>
              <Input placeholder="987654321" {...register("phone_number_id")} />
              {errors.phone_number_id && (
                <p className="text-xs text-destructive">{errors.phone_number_id.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Token de acceso</Label>
              <Input type="password" placeholder="EAAxxxxxxx" {...register("access_token")} />
              {errors.access_token && (
                <p className="text-xs text-destructive">{errors.access_token.message}</p>
              )}
            </div>
            <Button type="submit" disabled={isSubmitting || connectMut.isPending}>
              {connectMut.isPending ? "Conectando…" : connected ? "Actualizar conexión" : "Conectar"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Probar bot</CardTitle>
          <CardDescription>
            Prueba tus flujos sin enviar mensajes reales por WhatsApp
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="Escribe un mensaje de prueba…"
              value={dryRunMsg}
              onChange={(e) => setDryRunMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleDryRun()}
            />
            <Button
              onClick={handleDryRun}
              disabled={dryRunRunning || !dryRunMsg.trim()}
              className="shrink-0"
            >
              {dryRunRunning ? "Probando…" : "Enviar"}
            </Button>
          </div>
          {dryRunResult !== null && (
            <Textarea readOnly value={dryRunResult} className="min-h-[100px] text-sm" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
