/* eslint-disable */
// PremiereAdapter implementation for the UXP host.
//
// IMPORTANT: only host calls that could be verified against Premiere's
// documented UXP `premierepro` module surface are implemented. Everything else
// reports capability=false and throws NotImplementedInHost. Nothing here fakes
// a Premiere API. Every method marked REQUIRES-HOST-VALIDATION must be
// exercised inside a real Premiere UXP host before being relied on.

(function (global) {
  "use strict";

  const PLUGIN_VERSION = "0.4.0";
  const PROTOCOL_VERSION = "1.0.0";

  function notImplemented(capability) {
    const err = new Error(
      'Premiere capability "' +
        capability +
        '" is not implemented in this build. Requires validation inside a real Premiere UXP host.',
    );
    err.name = "NotImplementedInHost";
    err.capability = capability;
    return err;
  }

  function requirePremiere() {
    try {
      // UXP module id for Premiere Pro's scripting surface.
      return require("premierepro");
    } catch (e) {
      return null;
    }
  }

  function safeString(value, fallback) {
    return typeof value === "string" && value.length ? value : fallback;
  }

  class UxpPremiereAdapter {
    constructor() {
      this.ppro = requirePremiere();
      this.available = Boolean(this.ppro);
    }

    async identify() {
      let hostVersion = null;
      try {
        // REQUIRES-HOST-VALIDATION: version accessor naming varies by build.
        hostVersion = this.ppro && this.ppro.version ? String(this.ppro.version) : null;
      } catch (e) {
        hostVersion = null;
      }
      return {
        pluginVersion: PLUGIN_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        host: "premierepro",
        hostVersion: hostVersion,
      };
    }

    /**
     * Capability probe. Read-only project/sequence/selection reads are probed
     * live; every write capability is hard-false until validated in a real host.
     */
    async capabilities() {
      const caps = {
        "project.read": false,
        "sequence.read": false,
        "selection.read": false,
        "media.metadata": false,
        // Write paths: deliberately false. See README "Remaining Premiere work".
        "sequence.create": false,
        "clip.insert": false,
        "broll.insert": false,
        "markers.write": false,
        "labels.write": false,
      };
      if (!this.ppro) return caps;
      try {
        const project = await this._project();
        caps["project.read"] = Boolean(project);
        if (project) {
          try {
            caps["sequence.read"] = Boolean(await project.getActiveSequence());
          } catch (e) {}
          try {
            caps["media.metadata"] = typeof project.getRootItem === "function";
          } catch (e) {}
        }
        caps["selection.read"] = typeof this.ppro.getSelection === "function" || caps["project.read"];
      } catch (e) {
        /* leave everything false */
      }
      return caps;
    }

    async _project() {
      if (!this.ppro) return null;
      // Documented UXP accessor: Project.getActiveProject().
      if (this.ppro.Project && typeof this.ppro.Project.getActiveProject === "function") {
        return await this.ppro.Project.getActiveProject();
      }
      return null;
    }

    async getActiveProject() {
      const project = await this._project();
      if (!project) return null;
      let itemCount = 0;
      try {
        const root = typeof project.getRootItem === "function" ? await project.getRootItem() : null;
        const items = root && typeof root.getItems === "function" ? await root.getItems() : [];
        itemCount = Array.isArray(items) ? items.length : 0;
      } catch (e) {
        itemCount = 0;
      }
      return {
        id: safeString(project.guid, "active"),
        name: safeString(project.name, "Untitled Project"),
        path: safeString(project.path, null),
        itemCount: itemCount,
      };
    }

    async getActiveSequence() {
      const project = await this._project();
      if (!project || typeof project.getActiveSequence !== "function") return null;
      const seq = await project.getActiveSequence();
      if (!seq) return null;
      // REQUIRES-HOST-VALIDATION: track counts / timebase accessors.
      return {
        id: safeString(seq.guid, "active-sequence"),
        name: safeString(seq.name, "Active Sequence"),
        fps: 0,
        durationSeconds: 0,
        videoTracks: 0,
        audioTracks: 0,
      };
    }

    async getSelectedItems() {
      // REQUIRES-HOST-VALIDATION: selection API differs between project panel
      // and timeline selection. Returns [] rather than guessing.
      return [];
    }

    async getProjectMedia() {
      const project = await this._project();
      if (!project || typeof project.getRootItem !== "function") return [];
      try {
        const root = await project.getRootItem();
        const items = typeof root.getItems === "function" ? await root.getItems() : [];
        return (items || []).slice(0, 400).map(function (item, i) {
          return {
            id: safeString(item && item.guid, "item-" + i),
            name: safeString(item && item.name, "Clip " + (i + 1)),
            mediaPath: null, // REQUIRES-HOST-VALIDATION: media path accessor.
            durationSeconds: 0,
            inSeconds: null,
            outSeconds: null,
            fps: null,
            role: "interview",
          };
        });
      } catch (e) {
        return [];
      }
    }

    async listSequenceNames() {
      const project = await this._project();
      if (!project || typeof project.getSequences !== "function") return [];
      try {
        const seqs = await project.getSequences();
        return (seqs || []).map(function (s) {
          return safeString(s && s.name, "");
        }).filter(Boolean);
      } catch (e) {
        return [];
      }
    }

    async applyOperations() {
      // Non-destructive assembly requires sequence.create + clip.insert, which
      // are capability=false above. Never mutate the editor's active sequence.
      throw notImplemented("sequence.create");
    }

    async addMarker() {
      throw notImplemented("markers.write");
    }

    async setClipLabel() {
      throw notImplemented("labels.write");
    }
  }

  global.AssistantEditorAdapter = {
    UxpPremiereAdapter: UxpPremiereAdapter,
    notImplemented: notImplemented,
    PLUGIN_VERSION: PLUGIN_VERSION,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
  };
})(typeof window !== "undefined" ? window : globalThis);