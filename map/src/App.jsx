import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Map from './components/Map';
import Sidebar from './components/Sidebar';
import './index.css';

function App() {
  const [projects, setProjects] = useState(() => {
    const saved = localStorage.getItem('lifestreams_projects');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.length > 0) {
          // Migration: Consolidate old countryNames into master dict and clean up nations
          return parsed.map(project => {
            const masterNames = { ...(project.countryNames || {}) };
            const cleanNations = project.unifiedNations.map(nation => {
              if (nation.countryNames) {
                Object.entries(nation.countryNames).forEach(([id, name]) => {
                  masterNames[id] = name;
                });
                const { countryNames, ...cleanNation } = nation;
                return cleanNation;
              }
              return nation;
            });
            return { ...project, countryNames: masterNames, unifiedNations: cleanNations };
          });
        }
      } catch (e) {
        console.error("Failed to load projects", e);
      }
    }
    return [{ id: uuidv4(), name: 'Version 1', createdAt: Date.now(), unifiedNations: [], countryNames: {} }];
  });
  
  const [currentProjectId, setCurrentProjectId] = useState(projects[0].id);

  // Auto-save to localStorage whenever projects change
  useEffect(() => {
    localStorage.setItem('lifestreams_projects', JSON.stringify(projects));
  }, [projects]);

  const currentProject = projects.find(p => p.id === currentProjectId) || projects[0];
  const unifiedNations = currentProject.unifiedNations;

  const updateCurrentProject = (updater) => {
    setProjects(prev => prev.map(p => {
      if (p.id === currentProjectId) {
        return typeof updater === 'function' ? updater(p) : { ...p, ...updater };
      }
      return p;
    }));
  };

  const updateCurrentProjectNations = (updater) => {
    updateCurrentProject(p => ({
      ...p,
      unifiedNations: typeof updater === 'function' ? updater(p.unifiedNations) : updater
    }));
  };

  const createNewProject = () => {
    const newVersionNum = projects.length + 1;
    const newProject = {
      id: uuidv4(),
      name: `Version ${newVersionNum}`,
      createdAt: Date.now(),
      unifiedNations: [],
      countryNames: {}
    };
    setProjects(prev => [...prev, newProject]);
    setCurrentProjectId(newProject.id);
    clearSelection();
    setEditingId(null);
  };

  const [selectedCountries, setSelectedCountries] = useState([]);
  const [tooltipContent, setTooltipContent] = useState("");
  const [editingId, setEditingId] = useState(null);

  const masterCountryNames = currentProject.countryNames || {};

  const toggleCountrySelection = (id, name) => {
    updateCurrentProject(p => {
      const existingNames = p.countryNames || {};
      if (existingNames[id] === name) return p;
      return { ...p, countryNames: { ...existingNames, [id]: name } };
    });

    if (editingId) {
      const editingNation = unifiedNations.find(un => un.id === editingId);
      if (!editingNation) return;

      const otherUnifiedNation = unifiedNations.find(un => un.id !== editingId && un.countries.includes(id));
      if (otherUnifiedNation) return; 

      updateCurrentProjectNations(prev => prev.map(n => {
        if (n.id === editingId) {
          const hasCountry = n.countries.includes(id);
          const newCountries = hasCountry ? n.countries.filter(c => c !== id) : [...n.countries, id];
          return { ...n, countries: newCountries };
        }
        return n;
      }));
    } else {
      const isInUnifiedNation = unifiedNations.some(un => un.countries.includes(id));
      if (isInUnifiedNation) return;

      setSelectedCountries(prev => {
        if (prev.includes(id)) {
          return prev.filter(c => c !== id);
        } else {
          return [...prev, id];
        }
      });
    }
  };

  const clearSelection = () => {
    setSelectedCountries([]);
  };

  const addUnifiedNation = (nation) => {
    updateCurrentProjectNations(prev => [...prev, nation]);
  };

  const removeUnifiedNation = (id) => {
    updateCurrentProjectNations(prev => prev.filter(n => n.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const updateUnifiedNation = (id, newName, newColor) => {
    updateCurrentProjectNations(prev => prev.map(n => 
      n.id === id ? { ...n, name: newName, color: newColor } : n
    ));
  };

  const exportState = async () => {
    try {
      const versionMatch = currentProject.name.match(/\d+/);
      const versionNum = versionMatch ? versionMatch[0] : '1';
      const filename = `lifestream_map_v${versionNum}.json`;

      const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content: currentProject })
      });
      
      const result = await response.json();
      if (result.success) {
        alert(result.message);
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      console.error("Failed to save file locally", err);
      alert("Failed to save file to the saves folder.");
    }
  };

  const importState = (importedProject) => {
    // If it's a legacy format (just an array of unifiedNations), wrap it
    let newProject;
    if (Array.isArray(importedProject)) {
      newProject = {
        id: uuidv4(),
        name: `Imported Version ${projects.length + 1}`,
        createdAt: Date.now(),
        unifiedNations: importedProject,
        countryNames: {}
      };
    } else if (importedProject && importedProject.unifiedNations) {
      newProject = {
        ...importedProject,
        id: uuidv4(), // generate new ID to avoid collisions
        name: importedProject.name || `Imported Version ${projects.length + 1}`,
        createdAt: Date.now(), // Treat as a new project locally
        countryNames: importedProject.countryNames || {}
      };
    } else {
      alert("Invalid map file format.");
      return;
    }
    
    // Migration: Consolidate imported countryNames
    const masterNames = { ...newProject.countryNames };
    newProject.unifiedNations = newProject.unifiedNations.map(nation => {
      if (nation.countryNames) {
        Object.entries(nation.countryNames).forEach(([id, name]) => {
          masterNames[id] = name;
        });
        const { countryNames, ...cleanNation } = nation;
        return cleanNation;
      }
      return nation;
    });
    newProject.countryNames = masterNames;
    
    setProjects(prev => [...prev, newProject]);
    setCurrentProjectId(newProject.id);
    clearSelection();
    setEditingId(null);
  };

  return (
    <div className="app-container">
      <Sidebar 
        projects={projects}
        currentProjectId={currentProjectId}
        setCurrentProjectId={(id) => {
          setCurrentProjectId(id);
          clearSelection();
          setEditingId(null);
        }}
        createNewProject={createNewProject}
        selectedCountries={selectedCountries}
        masterCountryNames={masterCountryNames}
        toggleCountrySelection={toggleCountrySelection}
        clearSelection={clearSelection}
        addUnifiedNation={addUnifiedNation}
        unifiedNations={unifiedNations}
        removeUnifiedNation={removeUnifiedNation}
        updateUnifiedNation={updateUnifiedNation}
        importState={importState}
        exportState={exportState}
        editingId={editingId}
        setEditingId={setEditingId}
      />
      
      <div style={{ position: 'relative', flex: 1 }}>
        <Map 
          selectedCountries={selectedCountries}
          toggleCountrySelection={toggleCountrySelection}
          unifiedNations={unifiedNations}
          setTooltipContent={setTooltipContent}
          editingId={editingId}
        />
        
        {tooltipContent && (
          <div 
            className="map-tooltip"
            style={{ 
              top: '10px', 
              right: '10px', 
              position: 'absolute',
              transform: 'none',
              marginTop: '0'
            }}
          >
            {tooltipContent}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
