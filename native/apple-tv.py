#!/usr/bin/env python3
"""Device Deck Companion adapter. Adapted from George Cook's tv-remote.py."""
import asyncio, json, os, sys
async def main():
 import pyatv
 from pyatv.const import Protocol, OperatingSystem
 from pyatv.storage.file_storage import FileStorage
 op=sys.argv[1]; host=sys.argv[2] if len(sys.argv)>2 else None
 loop=asyncio.get_running_loop(); storage=FileStorage.default_storage(loop);await storage.load()
 devices=await pyatv.scan(loop,timeout=3,hosts=[host] if host else None,protocol=Protocol.Companion,storage=storage)
 devices=[d for d in devices if d.device_info.operating_system==OperatingSystem.TvOS]
 if op=='scan':
  print(json.dumps([dict(name=d.name,host=str(d.address),identifier=d.identifier) for d in devices if d.identifier]));return
 identifier=sys.argv[3] if len(sys.argv)>3 else None
 matches=[d for d in devices if d.identifier==identifier]
 if len(matches)!=1:raise RuntimeError('Apple TV not found with the configured identity')
 config=matches[0]; service=config.get_service(Protocol.Companion)
 if op=='inspect':print(json.dumps(dict(paired=bool(service.credentials))));return
 if op=='pair':
  pairing=await pyatv.pair(config,Protocol.Companion,loop,storage=storage,name='Device Deck')
  try:
   await pairing.begin();pin=await asyncio.to_thread(input,'PIN shown on Apple TV: ');pairing.pin(pin.strip());await pairing.finish()
   if not pairing.has_paired:raise RuntimeError('Pairing failed')
   os.umask(0o077);await storage.save();print('Paired')
  finally:await pairing.close()
  return
 if not service.credentials:raise RuntimeError('Pair Companion with devdeck apple-pair first')
 device=await pyatv.connect(config,loop,protocol=Protocol.Companion,storage=storage)
 try:
  value=sys.argv[4]
  if op=='text':await device.keyboard.text_append(value)
  else:
   keys={'Up':'up','Down':'down','Left':'left','Right':'right','OK':'select','Select':'select','Back':'menu','Menu':'menu','Home':'home','Play':'play_pause','Play / pause':'play_pause','VolumeUp':'volume_up','VolumeDown':'volume_down'}
   if value not in keys:raise RuntimeError('Unsupported Apple TV key')
   await getattr(device.remote_control,keys[value])()
  print(json.dumps(dict(ok=True)))
 finally:await asyncio.gather(*device.close(),return_exceptions=True)
try:asyncio.run(main())
except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
